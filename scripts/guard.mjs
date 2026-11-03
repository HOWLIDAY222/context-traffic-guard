import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readConnections, advance } from './traffic.mjs';

export const DEFAULTS = {
  compactionCheckpoints: [2, 5, 10, 20],
  trendSamples: 5,
  inputGrowthRatio: 2,
  speedRatio: 0.6,
  latencyRatio: 1.5,
  trafficWindowSeconds: 1800,
  trafficUploadBytes: 1073741824,
  reminderCooldownSeconds: 900,
};
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = number(value.input_tokens ?? value.inputTokens);
  const output = number(value.output_tokens ?? value.outputTokens);
  if (input === null || output === null) return null;
  const rawCached = number(value.cached_input_tokens ?? value.cachedInputTokens ??
    value.input_tokens_details?.cached_tokens);
  const rawReasoning = number(value.reasoning_output_tokens ?? value.reasoningOutputTokens ??
    value.output_tokens_details?.reasoning_tokens);
  return {
    input, output,
    cached: rawCached !== null && rawCached <= input ? rawCached : null,
    reasoning: rawReasoning !== null && rawReasoning <= output ? rawReasoning : null,
    total: number(value.total_tokens ?? value.totalTokens) ?? input + output,
  };
}
export const median = values => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export function openStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'metrics.sqlite'));
  db.exec('PRAGMA busy_timeout=800; PRAGMA journal_mode=WAL;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS sessions (' +
    'session TEXT, agent TEXT, started REAL, activity REAL, compact_count INTEGER DEFAULT 0,' +
    'compact_pending INTEGER DEFAULT 0, compact_unpaired INTEGER DEFAULT 0,' +
    'history_count INTEGER, history_source TEXT, last_notice REAL DEFAULT 0,' +
    'notice_keys TEXT DEFAULT \'[]\', PRIMARY KEY(session,agent));' +
    'CREATE TABLE IF NOT EXISTS requests (' +
    'id INTEGER PRIMARY KEY, session TEXT, agent TEXT, turn TEXT, model TEXT, effort TEXT,' +
    'started REAL, mono REAL, ended REAL, elapsed_ms REAL, status TEXT,' +
    'ambiguous INTEGER DEFAULT 0, input_tokens REAL, cached_tokens REAL,' +
    'output_tokens REAL, reasoning_tokens REAL, total_tokens REAL, error_category TEXT);' +
    'CREATE INDEX IF NOT EXISTS requests_scope ON requests(session,agent,id);' +
    'CREATE TABLE IF NOT EXISTS traffic (' +
    'id INTEGER PRIMARY KEY, ts REAL, segment TEXT, kernel_up REAL, kernel_down REAL,' +
    'codex_up REAL, codex_down REAL, sampled_up REAL, sampled_down REAL, source TEXT);' +
    'CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, value TEXT);'
  );
  return db;
}
function scope(event) {
  if (typeof event.session_id !== 'string' || !event.session_id || event.session_id.length > 200)
    throw new Error('missing or invalid session_id');
  return { session: event.session_id, agent: typeof event.agent_id === 'string' ? event.agent_id.slice(0,200) : 'root' };
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function ingest(db, event, now = Date.now(), mono = Number(process.hrtime.bigint() / 1000000n)) {
  const s = scope(event), name = event.hook_event_name;
  const turn = typeof event.turn_id === 'string' ? event.turn_id.slice(0,200) : '';
  const model = typeof event.model === 'string' ? event.model.slice(0,160) : 'unknown';
  const effort = ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(event.reasoning_effort)
    ? event.reasoning_effort : null;
  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO sessions(session,agent,started,activity) VALUES(?,?,?,?)')
      .run(s.session,s.agent,now,now);
    db.prepare('UPDATE sessions SET activity=? WHERE session=? AND agent=?').run(now,s.session,s.agent);
    if (name === 'PreCompact') {
      db.prepare('UPDATE sessions SET compact_pending=1 WHERE session=? AND agent=?').run(s.session,s.agent);
    } else if (name === 'PostCompact') {
      const row = db.prepare('SELECT compact_pending FROM sessions WHERE session=? AND agent=?').get(s.session,s.agent);
      db.prepare(row.compact_pending
        ? 'UPDATE sessions SET compact_count=compact_count+1,compact_pending=0 WHERE session=? AND agent=?'
        : 'UPDATE sessions SET compact_unpaired=compact_unpaired+1 WHERE session=? AND agent=?')
        .run(s.session,s.agent);
    } else if (name === 'PreModelRequest') {
      const prior = db.prepare(
        'SELECT id FROM requests WHERE session=? AND agent=? AND turn=? AND model=? AND status=\'pending\''
      ).all(s.session,s.agent,turn,model);
      if (prior.length) {
        db.prepare('UPDATE requests SET ambiguous=1 WHERE session=? AND agent=? AND turn=? AND model=? AND status=\'pending\'')
          .run(s.session,s.agent,turn,model);
      }
      db.prepare('INSERT INTO requests(session,agent,turn,model,effort,started,mono,status,ambiguous) VALUES(?,?,?,?,?,?,?,\'pending\',?)')
        .run(s.session,s.agent,turn,model,effort,now,mono,prior.length ? 1 : 0);
    } else if (name === 'PostModelRequest') {
      const pending = db.prepare(
        'SELECT * FROM requests WHERE session=? AND agent=? AND turn=? AND model=? AND status=\'pending\' ORDER BY id'
      ).all(s.session,s.agent,turn,model);
      const u = normalizeUsage(event.token_usage);
      const status = ['completed','failed','cancelled'].includes(event.status) ? event.status : 'unknown';
      let category = null;
      if (status === 'failed') {
        const error = typeof event.error === 'string' ? event.error : '';
        category = /429|rate.?limit/i.test(error) ? 'rate_limit' :
          /timeout|timed out/i.test(error) ? 'timeout' :
          /network|connect|stream/i.test(error) ? 'network' : 'other';
      }
      const match = pending[0];
      if (match) {
        const dt = mono - match.mono;
        const elapsed = pending.length === 1 && !match.ambiguous && dt > 0 && dt < 86400000 ? dt : null;
        db.prepare('UPDATE requests SET ended=?,elapsed_ms=?,status=?,input_tokens=?,cached_tokens=?,output_tokens=?,reasoning_tokens=?,total_tokens=?,error_category=? WHERE id=?')
          .run(now,elapsed,status,u?.input??null,u?.cached??null,u?.output??null,
            u?.reasoning??null,u?.total??null,category,match.id);
      } else {
        db.prepare('INSERT INTO requests(session,agent,turn,model,effort,ended,status,input_tokens,cached_tokens,output_tokens,reasoning_tokens,total_tokens,error_category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(s.session,s.agent,turn,model,effort,now,status,u?.input??null,u?.cached??null,
            u?.output??null,u?.reasoning??null,u?.total??null,category);
      }
    }
  });
  return s;
}
function comparableKey(r) {
  const bucket = n => Math.floor(Math.log2(Math.max(n,1)));
  const fraction = (n,d) => n === null ? 'unknown' : Math.min(3,Math.floor(n / Math.max(d,1) * 4));
  return [r.model,r.effort??'unknown',bucket(r.input_tokens),bucket(r.output_tokens),
    fraction(r.cached_tokens,r.input_tokens),fraction(r.reasoning_tokens,r.output_tokens)].join('|');
}
export function summarize(db, session, agent = 'root', now = Date.now(), policy = DEFAULTS) {
  const s = db.prepare('SELECT * FROM sessions WHERE session=? AND agent=?').get(session,agent);
  if (!s) return { session, agent, status: 'no_observations', alerts: [] };
  const rows = db.prepare('SELECT * FROM requests WHERE session=? AND agent=? ORDER BY id')
    .all(session,agent);
  const completed = rows.filter(r => r.status === 'completed' && r.input_tokens !== null);
  const last = completed.at(-1);
  const sameModel = last ? completed.filter(r => r.model === last.model) : [];
  const n = policy.trendSamples;
  const inputTrend = sameModel.length >= n * 2 ? {
    baseline: median(sameModel.slice(0,n).map(r=>r.input_tokens)),
    recent: median(sameModel.slice(-n).map(r=>r.input_tokens)),
  } : null;
  if (inputTrend) inputTrend.ratio = inputTrend.baseline > 0 ? inputTrend.recent / inputTrend.baseline : null;
  const groups = new Map();
  for (const r of rows.filter(r=>r.status==='completed' && r.elapsed_ms>0 &&
    r.input_tokens!==null && r.output_tokens>=64)) {
    const key = comparableKey(r);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  const latestKey = last && last.elapsed_ms > 0 && last.output_tokens >= 64 ? comparableKey(last) : null;
  const candidates = latestKey ? groups.get(latestKey) ?? [] : [];
  let speed = { status: 'insufficient_comparable_samples', ttft_ms: null };
  if (candidates.length >= n * 2) {
    const base = candidates.slice(0,n), recent = candidates.slice(-n);
    const rate = r => r.output_tokens / (r.elapsed_ms/1000);
    const baseRate = median(base.map(rate)), recentRate = median(recent.map(rate));
    const baseMs = median(base.map(r=>r.elapsed_ms)), recentMs = median(recent.map(r=>r.elapsed_ms));
    speed = {
      status:'measured_request_end_to_end', model:last.model, effort:last.effort,
      baseline_samples:n,recent_samples:n,baseline_output_tokens_per_second:baseRate,
      recent_output_tokens_per_second:recentRate,ratio:baseRate>0?recentRate/baseRate:null,
      baseline_request_ms:baseMs,recent_request_ms:recentMs,latency_ratio:recentMs/baseMs,
      ttft_ms:null,
      includes:'queue, network, reasoning, generation; excludes tool execution between requests',
      comparability:'same model, effort when available, input/output size and cache/reasoning ratio buckets',
    };
  }
  const trafficRows = db.prepare('SELECT * FROM traffic WHERE ts>=? ORDER BY ts')
    .all(now-policy.trafficWindowSeconds*1000);
  const t1=trafficRows.at(-1), t0=t1 ? trafficRows.find(r=>r.segment===t1.segment&&r.source===t1.source) : null;
  const system=t1?.source.startsWith('system|'), sourceParts=system?t1.source.split('|'):[];
  let traffic = {status:'unavailable',provider:null,scope:'no traffic source observed; context monitoring is independent'};
  if(t1) traffic={...traffic,provider:system?'system_interface':'mihomo',
    scope:system?'selected network interface; all programs and all chats; no process attribution':
      'all local Mihomo traffic; process samples span all chats',
    ...(system?{platform:sourceParts[1],interface:decodeURIComponent(sourceParts[2])}:{})};
  if(t0 && t1 && t1.ts>t0.ts && t0.segment===t1.segment) {
    traffic={...traffic,status:'measured',seconds:(t1.ts-t0.ts)/1000,
      kernel_upload_bytes:t1.kernel_up-t0.kernel_up,kernel_download_bytes:t1.kernel_down-t0.kernel_down,
      upload_bytes:t1.kernel_up-t0.kernel_up,download_bytes:t1.kernel_down-t0.kernel_down,
      codex_chatgpt_upload_lower_bound:system?null:t1.codex_up-t0.codex_up,
      codex_chatgpt_download_lower_bound:system?null:t1.codex_down-t0.codex_down,
      freshness_seconds:(now-t1.ts)/1000,source:t1.source};
    if(traffic.freshness_seconds>10) traffic.status='stale';
  }
  const count=(s.history_count??0)+s.compact_count;
  const alerts=[];
  const checkpoint=policy.compactionCheckpoints.filter(v=>count>=v).at(-1);
  if(checkpoint) alerts.push({key:'compact:'+checkpoint,kind:'compactions',
    severity:checkpoint>=10?'handoff':'review',message:'已记录压缩 '+count+' 次；到达试行交接检查点 '+checkpoint+'。'});
  if(inputTrend?.ratio>=policy.inputGrowthRatio)
    alerts.push({key:'input_growth',kind:'token_growth',severity:'review',
      message:'相同模型最近输入 Token 中位数约为初期的 '+inputTrend.ratio.toFixed(1)+' 倍。'});
  if(speed.ratio!==null && speed.ratio<=policy.speedRatio && speed.latency_ratio>=policy.latencyRatio)
    alerts.push({key:'speed_drop',kind:'request_speed',severity:'handoff',
      message:'可比请求的有效输出速率降至基线约 '+Math.round(speed.ratio*100)+'%；原因未确定。'});
  if(traffic.status==='measured' && traffic.kernel_upload_bytes>=policy.trafficUploadBytes)
    alerts.push({key:'traffic:'+t1.source+':'+Math.floor(now/(policy.trafficWindowSeconds*1000)),kind:'traffic',severity:'review',
      message:(system?'所选网卡':'本机代理')+'在该采样窗上传约 '+(traffic.kernel_upload_bytes/1073741824).toFixed(2)+' GiB，包含其他程序或会话的流量。'});
  const failures=rows.filter(r=>r.status==='failed');
  if(failures.some(r=>r.error_category==='rate_limit'))
    alerts.push({key:'rate_limit_observed',kind:'rate_limit',severity:'review',message:'模型请求明确返回过限速错误；与上下文因果关系未确定。'});
  return {
    session,agent,status:'observed',
    agent_scope:agent==='root'?'events without agent_id; agents cannot be separated if the source omits it':'explicit agent_id',
    compactions:{historical_record_count:s.history_count,
      historical_source:s.history_source,completed_since_activation:s.compact_count,
      known_total:count,coverage:s.history_count===null?'since_activation_only':'supplied_rollout_plus_hooks',
      unpaired_postcompact_events:s.compact_unpaired},
    tokens:{completed_requests:completed.length,latest_input:last?.input_tokens??null,
      latest_cached_input:last?.cached_tokens??null,latest_output:last?.output_tokens??null,
      recorded_total:completed.length?completed.reduce((a,r)=>a+(r.total_tokens??0),0):null,
      account_quota_remaining:null,input_trend:inputTrend},
    requests:{observed_attempts:rows.length,failed:failures.length,
      pending:rows.filter(r=>r.status==='pending').length,
      timed:rows.filter(r=>r.elapsed_ms!==null).length},
    speed,traffic,alerts,
  };
}
export function hookOutput(db,event,report,now=Date.now(),policy=DEFAULTS) {
  const name=event.hook_event_name;
  if(!['PostCompact','PostToolUse','UserPromptSubmit','Stop'].includes(name)) return {};
  const s=db.prepare('SELECT * FROM sessions WHERE session=? AND agent=?').get(report.session,report.agent);
  const seen=new Set(JSON.parse(s.notice_keys)), fresh=report.alerts.filter(a=>!seen.has(a.key));
  const stronger=fresh.some(a=>a.severity==='handoff');
  if(!fresh.length || (!stronger && now-s.last_notice<policy.reminderCooldownSeconds*1000)) return {};
  const text='[上下文与流量监测] '+fresh.map(a=>a.message).join(' ') +
    ' 请在当前操作的安全阶段向用户提醒，并准备精简交接摘要。不要中断事务，不自动切窗，不宣称模型已变笨。';
  db.prepare('UPDATE sessions SET last_notice=?,notice_keys=? WHERE session=? AND agent=?')
    .run(now,JSON.stringify([...seen,...fresh.map(a=>a.key)].slice(-80)),report.session,report.agent);
  if(['PostToolUse','UserPromptSubmit'].includes(name))
    return {hookSpecificOutput:{hookEventName:name,additionalContext:text}};
  return {systemMessage:text};
}
export function loadPolicy(path) {
  if(!path) return {...DEFAULTS};
  const given=JSON.parse(readFileSync(path,'utf8')), result={...DEFAULTS};
  for(const key of Object.keys(DEFAULTS)) if(key in given) {
    if(key==='compactionCheckpoints') {
      if(!Array.isArray(given[key])||!given[key].length||!given[key].every(v=>Number.isSafeInteger(v)&&v>0)) throw new Error('invalid checkpoints');
      result[key]=[...new Set(given[key])].sort((a,b)=>a-b);
    } else {
      if(!Number.isFinite(given[key])||given[key]<=0) throw new Error('invalid policy');
      if(['trendSamples','trafficWindowSeconds','trafficUploadBytes','reminderCooldownSeconds'].includes(key) &&
        !Number.isSafeInteger(given[key])) throw new Error('integer policy value required');
      result[key]=given[key];
    }
  }
  return result;
}
export function storeTrafficSnapshot(db,snapshot,ts=Date.now(),source='mihomo_event_sample') {
  transaction(db,()=>{
    const cursorKey=source==='mihomo_event_sample'?'traffic_cursor':'traffic_cursor:'+source;
    const row=db.prepare('SELECT value FROM runtime WHERE key=?').get(cursorKey);
    const old=row?JSON.parse(row.value):null;
    if(old&&ts<=old.ts) return;
    const reset=!old||snapshot.uploadTotal<old.kernel_up||snapshot.downloadTotal<old.kernel_down;
    let segment=reset?randomUUID():old.segment;
    let totals={codex_up:0,codex_down:0,sampled_up:0,sampled_down:0}, next;
    if(reset) next=new Map(snapshot.connections.filter(c=>typeof c.id==='string')
      .map(c=>[c.id,{upload:c.upload,download:c.download}]));
    else {
      const step=advance(new Map(old.connections),snapshot,old.totals);
      totals=step.totals;next=step.next;
    }
    const cursor={ts,segment,kernel_up:snapshot.uploadTotal,kernel_down:snapshot.downloadTotal,
      totals,connections:[...next]};
    db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)')
      .run(cursorKey,JSON.stringify(cursor));
    db.prepare('INSERT INTO traffic(ts,segment,kernel_up,kernel_down,codex_up,codex_down,sampled_up,sampled_down,source) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(ts,segment,snapshot.uploadTotal,snapshot.downloadTotal,totals.codex_up,totals.codex_down,
        totals.sampled_up,totals.sampled_down,source);
    db.prepare('DELETE FROM traffic WHERE ts<?').run(ts-7200000);
  });
}
export function storeSystemSnapshot(db,snapshot,ts=Date.now()) {
  if(!['win32','darwin','linux'].includes(snapshot.platform)||typeof snapshot.name!=='string'||
    !snapshot.name||snapshot.name.length>256||
    ![snapshot.uploadTotal,snapshot.downloadTotal].every(n=>Number.isSafeInteger(n)&&n>=0))
    throw new Error('invalid system interface counters');
  const source='system|'+snapshot.platform+'|'+encodeURIComponent(snapshot.name), key='traffic_cursor:'+source;
  transaction(db,()=>{
    const row=db.prepare('SELECT value FROM runtime WHERE key=?').get(key), old=row?JSON.parse(row.value):null;
    if(old&&ts<=old.ts) return;
    const reset=!old||snapshot.uploadTotal<old.up||snapshot.downloadTotal<old.down;
    const segment=reset?randomUUID():old.segment;
    db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)')
      .run(key,JSON.stringify({ts,segment,up:snapshot.uploadTotal,down:snapshot.downloadTotal}));
    db.prepare('INSERT INTO traffic(ts,segment,kernel_up,kernel_down,codex_up,codex_down,sampled_up,sampled_down,source) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(ts,segment,snapshot.uploadTotal,snapshot.downloadTotal,null,null,null,null,source);
    db.prepare('DELETE FROM traffic WHERE ts<?').run(ts-7200000);
  });
}
async function sampleTraffic(db,pipe) {
  const source='mihomo_event_sample:'+createHash('sha256').update(pipe).digest('hex').slice(0,16);
  const row=db.prepare('SELECT value FROM runtime WHERE key=?').get('traffic_cursor:'+source);
  if(row&&Date.now()-JSON.parse(row.value).ts<500) return;
  try {storeTrafficSnapshot(db,await readConnections(pipe,150),Date.now(),source);}
  catch {} // A missing local counter must never delay or block the business task.
}
function argumentsOf(args) {
  const result={command:args[0]??'report'};
  for(let i=1;i<args.length;i++) {
    const key=args[i];
    if(key==='--auto-watch') result.autoWatch=true;
    else if(key==='--sample-traffic') result.sampleTraffic=true;
    else if(key.startsWith('--')) result[key.slice(2)]=args[++i];
    else throw new Error('unexpected argument');
  }
  return result;
}
async function main() {
  const a=argumentsOf(process.argv.slice(2)), stateDir=resolve(a['state-dir']??join(homedir(),'.codex','context-traffic-guard-state'));
  const db=openStore(stateDir), policy=loadPolicy(a.policy??
    join(dirname(fileURLToPath(import.meta.url)),'..','integration','policy.json'));
  try {
    if(a.command==='hook') {
      const chunks=[];let bytes=0;
      for await(const chunk of process.stdin) {
        bytes+=chunk.length;
        if(bytes>4194304) throw new Error('hook payload too large');
        chunks.push(chunk);
      }
      const event=JSON.parse(Buffer.concat(chunks).toString('utf8')), s=ingest(db,event);
      const endpoint=a.pipe??a.socket??a.endpoint;
      if(a.sampleTraffic&&endpoint) await sampleTraffic(db,endpoint);
      if(['PostCompact','PostToolUse','UserPromptSubmit','Stop'].includes(event.hook_event_name)) {
        const report=summarize(db,s.session,s.agent,Date.now(),policy);
        process.stdout.write(JSON.stringify(hookOutput(db,event,report,Date.now(),policy)));
      } else process.stdout.write('{}');
    } else if(a.command==='report') {
      const session=a.session??process.env.CODEX_THREAD_ID;
      if(!session) throw new Error('session required');
      process.stdout.write(JSON.stringify(summarize(db,session,a.agent??'root',Date.now(),policy),null,2));
    } else throw new Error('use hook or report');
  } finally {db.close();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(()=>{
    if(process.argv[2]==='hook') {
      process.stdout.write('{}');
      process.stderr.write('context-traffic-guard: observation unavailable; task continues.\n');
    } else {process.stderr.write('context-traffic-guard: command failed.\n');process.exitCode=1;}
  });
}
