import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { summarize, comparableKey } from './guard.mjs';

export const DRAFT_FIELDS = ['goal', 'completed', 'next', 'files', 'constraints'];
export const encodeSelection = row => Buffer.from(JSON.stringify([row.session,row.agent])).toString('base64url');
export function decodeSelection(key) {
  if(typeof key!=='string'||key.length>3000||!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('invalid_selection');
  const value=JSON.parse(Buffer.from(key,'base64url').toString('utf8'));
  if(!Array.isArray(value)||value.length!==2||value.some(v=>typeof v!=='string'||!v||v.length>600)) throw new Error('invalid_selection');
  return value;
}
export function withStore(stateDir, action) {
  const path=join(stateDir,'metrics.sqlite');
  if(!existsSync(path)) return {ok:false,code:'no_database',message:'尚未接入数据。请指定实际状态目录，并先让客户端产生监测事件。'};
  let db;
  try {
    db=new DatabaseSync(path,{readOnly:true});
    db.exec('PRAGMA busy_timeout=400; BEGIN;');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    if(!['sessions','requests','clients','context_snapshots','usage_observations','traffic'].every(t=>tables.has(t)))
      return {ok:false,code:'schema_outdated',message:'监测数据库版本较旧。请先更新采集器并验证客户端事件，面板不会修改原数据库。'};
    const result=action(db);
    db.exec('COMMIT;');
    return {ok:true,...result};
  } finally {if(db) db.close();}
}
export function sessionsIn(db) {
  return db.prepare('SELECT s.session,s.agent,s.started,s.activity,COALESCE(c.client,\'codex\') client,COALESCE(c.raw_session,s.session) raw_session,c.source FROM sessions s LEFT JOIN clients c USING(session,agent) ORDER BY s.activity DESC LIMIT 200')
    .all().map(row=>({...row,key:encodeSelection(row)}));
}
export function diagnostics(report) {
  const result=report.alerts.map(a=>({kind:a.kind,level:a.severity,title:a.kind==='compactions'?'已到压缩检查点':a.kind==='context_pressure'?'上下文接近试行提醒值':a.kind==='request_speed'?'可比请求持续变慢':a.kind==='traffic'?'采样窗上传量较高':a.kind==='rate_limit'?'曾收到明确限速错误':'近期输入增长',
    evidence:a.message,action:a.severity==='handoff'?'建议到可恢复检查点后交接。先确认任务状态，再决定是否换窗。':'检查任务阶段与近期操作；提醒阈值是可配置的试行值。'}));
  if(report.speed.status==='insufficient_comparable_samples') result.push({kind:'speed_unknown',level:'unknown',title:'目前不能判断速度是否下降',
    evidence:'没有足够的同模型、计时口径及规模相近的 5＋5 个请求样本。',action:'继续使用并积累可比记录；不以整轮工具耗时替代模型请求耗时。'});
  if(report.context.used_percentage===null) result.push({kind:'context_unknown',level:'unknown',title:'客户端尚未提供上下文占比',evidence:'输入 Token 与上下文窗口占用率不是同一指标。',action:'保留未知值；支持状态栏快照的客户端可选接入快照。'});
  if(report.traffic.status!=='measured') result.push({kind:'traffic_unknown',level:'unknown',title:report.traffic.status==='stale'?'流量采样已过期':'流量数据尚不可用',
    evidence:report.traffic.status==='stale'?'最后一次采样距今超过 10 秒，历史差值不能当作当前流量。':'还没有同一来源、同一计数段的两个有效样本。',action:'需要时针对明确的一张网卡启动有限时长采样，或使用已配置的代理采样。'});
  return result;
}
export function sessionData(db,key,minutes,now,policy) {
  const [session,agent]=decodeSelection(key);
  const selected=db.prepare('SELECT session,agent,activity,started FROM sessions WHERE session=? AND agent=?').get(session,agent);
  if(!selected) return null;
  const report=summarize(db,session,agent,now,policy), since=minutes===0?0:now-minutes*60000;
  const requestCount=db.prepare('SELECT COUNT(*) n FROM requests WHERE session=? AND agent=? AND COALESCE(ended,started)>=?').get(session,agent,since).n;
  const requests=db.prepare('SELECT id,started,ended,model,effort,status,input_tokens,cached_tokens,output_tokens,reasoning_tokens,total_tokens,elapsed_ms,error_category,timing_kind,ambiguous FROM requests WHERE session=? AND agent=? AND COALESCE(ended,started)>=? ORDER BY id DESC LIMIT 500').all(session,agent,since).reverse();
  const last=db.prepare("SELECT * FROM requests WHERE session=? AND agent=? AND status='completed' ORDER BY id DESC LIMIT 1").get(session,agent);
  const speedKey=last&&last.input_tokens!==null&&last.output_tokens>=64&&last.elapsed_ms>0?comparableKey(last):null;
  const rateRows=speedKey?requests.filter(r=>r.status==='completed'&&r.input_tokens!==null&&r.output_tokens>=64&&r.elapsed_ms>0&&comparableKey(r)===speedKey):[];
  const rates=rateRows.map(r=>({id:r.id,ts:r.ended,value:r.output_tokens/(r.elapsed_ms/1000)}));
  // The traffic curve has the same max-30-minute window as the core report.
  // Changing request-history range must not silently extend traffic attribution.
  const trafficSince=now-policy.trafficWindowSeconds*1000;
  const lastTraffic=db.prepare('SELECT source,segment FROM traffic WHERE ts>=? ORDER BY ts DESC,id DESC LIMIT 1').get(trafficSince);
  const traffic=lastTraffic?db.prepare('SELECT ts,kernel_up,kernel_down FROM traffic WHERE source=? AND segment=? AND ts>=? ORDER BY ts DESC,id DESC LIMIT 1200').all(lastTraffic.source,lastTraffic.segment,trafficSince).reverse():[];
  const trafficPoints=[];
  for(let i=1;i<traffic.length;i++) {
    const a=traffic[i-1],b=traffic[i],seconds=(b.ts-a.ts)/1000;
    if(seconds>0&&b.kernel_up>=a.kernel_up&&b.kernel_down>=a.kernel_down)
      trafficPoints.push({ts:b.ts,upload_per_second:(b.kernel_up-a.kernel_up)/seconds,download_per_second:(b.kernel_down-a.kernel_down)/seconds});
  }
  return {report,diagnostics:diagnostics(report),activity:selected.activity,started:selected.started,
    history:{since,minutes,total_requests:requestCount,truncated:requestCount>requests.length,requests,rates,
      traffic:trafficPoints,traffic_window_seconds:policy.trafficWindowSeconds,
      rate_scope:'latest comparable request group; same model, effort, timing, size and cache/reasoning buckets'}};
}
export function readHandoffSeed(path,selection) {
  if(!path) return {status:'none',fields:{}};
  try {
    if(statSync(path).size>65536) return {status:'invalid',fields:{}};
    const raw=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
    if(raw.version!==1||!raw.fields||typeof raw.fields!=='object') return {status:'invalid',fields:{}};
    if(raw.client!==selection.client||raw.session_id!==selection.raw_session||(raw.agent_id??'root')!==selection.agent||
      (selection.client==='generic'&&(raw.source??'custom')!==selection.source)) return {status:'different_session',fields:{}};
    const fields={};
    for(const key of DRAFT_FIELDS) if(typeof raw.fields[key]==='string'&&raw.fields[key].length<=8000) fields[key]=raw.fields[key];
    return {status:'matched',fields};
  } catch {return {status:'unavailable',fields:{}};}
}
