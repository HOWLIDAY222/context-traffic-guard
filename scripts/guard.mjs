import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readConnections, advance } from './traffic.mjs';
import { CLIENTS, normalizeEvent, statusSnapshot, sessionKey, canRemind, reminderOutput, renderStatus } from './adapters.mjs';

export const DEFAULTS = {
  compactionCheckpoints: [2, 5, 10, 20],
  trendSamples: 5,
  inputGrowthRatio: 2,
  speedRatio: 0.6,
  latencyRatio: 1.5,
  trafficWindowSeconds: 1800,
  trafficUploadBytes: 1073741824,
  reminderCooldownSeconds: 900,
  contextUsedPercent: 80,
};
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = number(value.input_tokens ?? value.inputTokens);
  const output = number(value.output_tokens ?? value.outputTokens);
  const suppliedTotal = number(value.total_tokens ?? value.totalTokens);
  if (input === null && output === null && suppliedTotal === null) return null;
  const rawCached = number(value.cached_input_tokens ?? value.cachedInputTokens ??
    value.input_tokens_details?.cached_tokens);
  const rawReasoning = number(value.reasoning_output_tokens ?? value.reasoningOutputTokens ??
    value.output_tokens_details?.reasoning_tokens);
  return {
    input, output,
    cached: input !== null && rawCached !== null && rawCached <= input ? rawCached : null,
    reasoning: output !== null && rawReasoning !== null && rawReasoning <= output ? rawReasoning : null,
    total: suppliedTotal ?? (input !== null && output !== null ? input + output : null),
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
    'CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, value TEXT);' +
    'CREATE TABLE IF NOT EXISTS clients (session TEXT,agent TEXT,client TEXT,raw_session TEXT,source TEXT,PRIMARY KEY(session,agent));' +
    'CREATE TABLE IF NOT EXISTS context_snapshots (session TEXT,agent TEXT,model TEXT,ts REAL,used_percentage REAL,window_tokens REAL,input_tokens REAL,output_tokens REAL,usage TEXT,PRIMARY KEY(session,agent));' +
    'CREATE TABLE IF NOT EXISTS usage_observations (session TEXT,agent TEXT,model TEXT,ts REAL,usage TEXT,scope TEXT,PRIMARY KEY(session,agent));' +
    'CREATE TABLE IF NOT EXISTS event_keys (session TEXT,agent TEXT,kind TEXT,event_key TEXT,PRIMARY KEY(session,agent,kind,event_key));'
  );
  transaction(db,()=>{
    const requestColumns=new Set(db.prepare('PRAGMA table_info(requests)').all().map(r=>r.name));
    if(!requestColumns.has('external_id')) db.exec('ALTER TABLE requests ADD COLUMN external_id TEXT;');
    if(!requestColumns.has('timing_kind')) db.exec("ALTER TABLE requests ADD COLUMN timing_kind TEXT DEFAULT 'hook_pair';");
    if(!db.prepare('PRAGMA table_info(sessions)').all().some(r=>r.name==='compact_triggers'))
      db.exec('ALTER TABLE sessions ADD COLUMN compact_triggers INTEGER DEFAULT 0;');
  });
  return db;
}
function scope(event) {
  if (typeof event.session_id !== 'string' || !event.session_id || event.session_id.length > 600)
    throw new Error('missing or invalid session_id');
  return { session: event.session_id, agent: typeof event.agent_id === 'string' ? event.agent_id.slice(0,200) : 'root' };
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function mergeRequestUsage(db,row,usage) {
  if(!usage) return;
  const values=['input','cached','output','reasoning','total'].map((key,i)=>{
    const column=['input_tokens','cached_tokens','output_tokens','reasoning_tokens','total_tokens'][i];
    return usage[key]===null?row[column]:Math.max(row[column]??0,usage[key]);
  });
  db.prepare('UPDATE requests SET input_tokens=?,cached_tokens=?,output_tokens=?,reasoning_tokens=?,total_tokens=? WHERE id=?')
    .run(...values,row.id);
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
    if(event.client&&Object.hasOwn(CLIENTS,event.client)) db.prepare('INSERT OR REPLACE INTO clients(session,agent,client,raw_session,source) VALUES(?,?,?,?,?)')
      .run(s.session,s.agent,event.client,event.raw_session,event.source??'custom');
    if (name === 'PreCompact') {
      db.prepare('UPDATE sessions SET compact_pending=1,compact_triggers=compact_triggers+CASE WHEN compact_pending=0 THEN 1 ELSE 0 END WHERE session=? AND agent=?').run(s.session,s.agent);
    } else if (name === 'PostCompact') {
      const row = db.prepare('SELECT compact_pending FROM sessions WHERE session=? AND agent=?').get(s.session,s.agent);
      db.prepare(row.compact_pending
        ? 'UPDATE sessions SET compact_count=compact_count+1,compact_pending=0 WHERE session=? AND agent=?'
        : 'UPDATE sessions SET compact_unpaired=compact_unpaired+1 WHERE session=? AND agent=?')
        .run(s.session,s.agent);
    } else if(name==='CompressionTriggered') {
      db.prepare('UPDATE sessions SET compact_triggers=compact_triggers+1 WHERE session=? AND agent=?').run(s.session,s.agent);
    } else if(name==='ConfirmedCompact') {
      if(!event.event_id) throw new Error('completed generic compaction requires event_id');
      const inserted=db.prepare('INSERT OR IGNORE INTO event_keys(session,agent,kind,event_key) VALUES(?,?,?,?)')
        .run(s.session,s.agent,'compact',event.event_id).changes;
      if(inserted) db.prepare('UPDATE sessions SET compact_count=compact_count+1,compact_pending=0 WHERE session=? AND agent=?').run(s.session,s.agent);
    } else if(name==='Stop'&&event.client==='gemini') {
      db.prepare("UPDATE requests SET status='unresolved',ended=?,elapsed_ms=NULL WHERE session=? AND agent=? AND status='pending'")
        .run(now,s.session,s.agent);
    } else if(name==='ContextSnapshot') {
      const pct=number(event.context?.used_percentage), size=number(event.context?.window_tokens);
      db.prepare('INSERT OR REPLACE INTO context_snapshots(session,agent,model,ts,used_percentage,window_tokens,input_tokens,output_tokens,usage) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(s.session,s.agent,model,now,pct!==null&&pct<=100?pct:null,size>0?size:null,
          number(event.context_input_tokens),number(event.context_output_tokens),JSON.stringify(normalizeUsage(event.token_usage)));
    } else if (name === 'PreModelRequest') {
      if(event.request_id&&db.prepare('SELECT id FROM requests WHERE session=? AND agent=? AND external_id=?').get(s.session,s.agent,event.request_id)) return;
      const prior = db.prepare(
        'SELECT id FROM requests WHERE session=? AND agent=? AND turn=? AND model=? AND status=\'pending\''
      ).all(s.session,s.agent,turn,model);
      if (prior.length && !event.request_id) {
        db.prepare('UPDATE requests SET ambiguous=1 WHERE session=? AND agent=? AND turn=? AND model=? AND status=\'pending\'')
          .run(s.session,s.agent,turn,model);
      }
      db.prepare('INSERT INTO requests(session,agent,turn,model,effort,started,mono,status,ambiguous,external_id,timing_kind) VALUES(?,?,?,?,?,?,?,\'pending\',?,?,?)')
        .run(s.session,s.agent,turn,model,effort,now,mono,prior.length&&!event.request_id?1:0,event.request_id??null,event.timing_kind??'hook_pair');
    } else if(name==='ModelChunk') {
      const u=normalizeUsage(event.token_usage);
      if(u) db.prepare('INSERT OR REPLACE INTO usage_observations(session,agent,model,ts,usage,scope) VALUES(?,?,?,?,?,?)')
        .run(s.session,s.agent,model,now,JSON.stringify(u),'stream_chunk_not_added_to_request_totals');
      const pending=db.prepare("SELECT * FROM requests WHERE session=? AND agent=? AND model=? AND status='pending' ORDER BY id").all(s.session,s.agent,model);
      if(pending.length===1&&!pending[0].ambiguous) {
        mergeRequestUsage(db,pending[0],u);
        if(event.generation_finished) {
          const elapsed=mono-pending[0].mono;
          db.prepare("UPDATE requests SET status='completed',ended=?,elapsed_ms=?,timing_kind='finish_marker' WHERE id=?")
            .run(now,elapsed>0&&elapsed<86400000?elapsed:null,pending[0].id);
        }
      }
    } else if (name === 'PostModelRequest') {
      const pending = event.request_id?db.prepare('SELECT * FROM requests WHERE session=? AND agent=? AND external_id=?').all(s.session,s.agent,event.request_id):db.prepare(
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
      if(match&&match.status!=='pending') {mergeRequestUsage(db,match,u);return;}
      if (match) {
        const dt = mono - match.mono;
        const reported=number(event.elapsed_ms);
        const elapsed = reported>0&&reported<86400000?reported:
          pending.length === 1 && !match.ambiguous && dt > 0 && dt < 86400000 ? dt : null;
        db.prepare('UPDATE requests SET ended=?,elapsed_ms=?,status=?,input_tokens=?,cached_tokens=?,output_tokens=?,reasoning_tokens=?,total_tokens=?,error_category=? WHERE id=?')
          .run(now,elapsed,status,u?.input??null,u?.cached??null,u?.output??null,
            u?.reasoning??null,u?.total??null,category,match.id);
        if(reported>0) db.prepare("UPDATE requests SET timing_kind='caller_reported' WHERE id=?").run(match.id);
      } else {
        const reported=number(event.elapsed_ms);
        db.prepare('INSERT INTO requests(session,agent,turn,model,effort,ended,status,input_tokens,cached_tokens,output_tokens,reasoning_tokens,total_tokens,error_category,external_id,elapsed_ms,timing_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(s.session,s.agent,turn,model,effort,now,status,u?.input??null,u?.cached??null,
            u?.output??null,u?.reasoning??null,u?.total??null,category,event.request_id??null,
            reported>0&&reported<86400000?reported:null,reported>0?'caller_reported':null);
      }
    }
  });
  return s;
}
function comparableKey(r) {
  const bucket = n => Math.floor(Math.log2(Math.max(n,1)));
  const fraction = (n,d) => n === null ? 'unknown' : Math.min(3,Math.floor(n / Math.max(d,1) * 4));
  return [r.model,r.effort??'unknown',r.timing_kind??'hook_pair',bucket(r.input_tokens),bucket(r.output_tokens),
    fraction(r.cached_tokens,r.input_tokens),fraction(r.reasoning_tokens,r.output_tokens)].join('|');
}
export function summarize(db, session, agent = 'root', now = Date.now(), policy = DEFAULTS) {
  const s = db.prepare('SELECT * FROM sessions WHERE session=? AND agent=?').get(session,agent);
  if (!s) return { session, agent, status: 'no_observations', alerts: [] };
  const rows = db.prepare('SELECT * FROM requests WHERE session=? AND agent=? ORDER BY id')
    .all(session,agent);
  const completed = rows.filter(r => r.status === 'completed');
  const last = completed.at(-1);
  const sameModel = last ? completed.filter(r => r.model === last.model&&r.input_tokens!==null) : [];
  const clientRow=db.prepare('SELECT * FROM clients WHERE session=? AND agent=?').get(session,agent);
  const capabilities=CLIENTS[clientRow?.client??'codex'];
  const snapshot=db.prepare('SELECT * FROM context_snapshots WHERE session=? AND agent=?').get(session,agent);
  const observation=db.prepare('SELECT * FROM usage_observations WHERE session=? AND agent=?').get(session,agent);
  const context={used_percentage:snapshot?.used_percentage??null,window_tokens:snapshot?.window_tokens??null,
    input_tokens:snapshot?.input_tokens??null,output_tokens:snapshot?.output_tokens??null,
    source:snapshot?'client_status_snapshot':null};
  let latestUsage=last?{input:last.input_tokens,cached:last.cached_tokens,output:last.output_tokens,
    reasoning:last.reasoning_tokens,total:last.total_tokens}:null;
  let latestUsageSource=last?'request_record':null;
  if(snapshot&&(!last||snapshot.ts>last.ended)) {
    latestUsage=JSON.parse(snapshot.usage)??{input:snapshot.input_tokens,output:snapshot.output_tokens,cached:null,reasoning:null,total:null};
    latestUsageSource='current_context_snapshot_not_cumulative';
  }
  if(observation&&(!last||observation.ts>last.ended)&&(!snapshot||observation.ts>snapshot.ts)) {
    latestUsage=JSON.parse(observation.usage);latestUsageSource=observation.scope;
  }
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
  const latestKey = last && last.input_tokens!==null&&last.elapsed_ms > 0 && last.output_tokens >= 64 ? comparableKey(last) : null;
  const candidates = latestKey ? groups.get(latestKey) ?? [] : [];
  let speed = { status: 'insufficient_comparable_samples', ttft_ms: null };
  if (candidates.length >= n * 2) {
    const base = candidates.slice(0,n), recent = candidates.slice(-n);
    const rate = r => r.output_tokens / (r.elapsed_ms/1000);
    const baseRate = median(base.map(rate)), recentRate = median(recent.map(rate));
    const baseMs = median(base.map(r=>r.elapsed_ms)), recentMs = median(recent.map(r=>r.elapsed_ms));
    speed = {
      status:'measured_request_end_to_end', model:last.model, effort:last.effort,
      timing_kind:last.timing_kind??'hook_pair',
      baseline_samples:n,recent_samples:n,baseline_output_tokens_per_second:baseRate,
      recent_output_tokens_per_second:recentRate,ratio:baseRate>0?recentRate/baseRate:null,
      baseline_request_ms:baseMs,recent_request_ms:recentMs,latency_ratio:recentMs/baseMs,
      ttft_ms:null,
      includes:last.timing_kind==='finish_marker'?
        'before-model to generation finish marker; includes stream-hook overhead; trailing metadata may arrive later':
        'queue, network, reasoning, generation; excludes tool execution between requests',
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
  const count=capabilities.compaction_completion?(s.history_count??0)+s.compact_count:null;
  const alerts=[];
  const checkpoint=policy.compactionCheckpoints.filter(v=>(count??s.compact_triggers)>=v).at(-1);
  if(checkpoint) alerts.push({key:'compact:'+checkpoint,kind:'compactions',
    severity:checkpoint>=10?'handoff':'review',message:count===null?
      '已观察到压缩触发 '+s.compact_triggers+' 次；客户端没有提供完成事件，完成次数未知。':
      '已记录压缩 '+count+' 次；到达试行交接检查点 '+checkpoint+'。'});
  if(context.used_percentage!==null&&context.used_percentage>=policy.contextUsedPercent)
    alerts.push({key:'context_pressure',kind:'context_pressure',severity:'handoff',
      message:'客户端报告上下文使用约 '+context.used_percentage.toFixed(1)+'%；到达试行交接检查点。'});
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
    client:clientRow?.client??'codex',external_session_id:clientRow?.raw_session??session,
    source:clientRow?.source??null,capabilities,context,
    agent_scope:agent==='root'?'events without agent_id; agents cannot be separated if the source omits it':'explicit agent_id',
    compactions:{historical_record_count:s.history_count,
      historical_source:s.history_source,completed_since_activation:capabilities.compaction_completion?s.compact_count:null,
      triggered_since_activation:s.compact_triggers,known_total:count,
      coverage:!capabilities.compaction_completion?'trigger_events_only':s.history_count===null?'since_activation_only':'supplied_rollout_plus_hooks',
      unpaired_postcompact_events:s.compact_unpaired},
    tokens:{completed_requests:completed.length,latest_input:latestUsage?.input??null,
      latest_cached_input:latestUsage?.cached??null,latest_output:latestUsage?.output??null,
      latest_total:latestUsage?.total??null,latest_source:latestUsageSource,
      requests_with_total:completed.filter(r=>r.total_tokens!==null).length,
      recorded_total:completed.some(r=>r.total_tokens!==null)?completed.reduce((a,r)=>a+(r.total_tokens??0),0):null,
      recorded_total_scope:'completed request records only; excludes current-context and unpaired stream observations',
      account_quota_remaining:null,input_trend:inputTrend},
    requests:{observed_attempts:rows.length,failed:failures.length,
      pending:rows.filter(r=>r.status==='pending').length,
      unresolved:rows.filter(r=>r.status==='unresolved').length,
      timed:rows.filter(r=>r.elapsed_ms!==null).length},
    speed,traffic,alerts,
  };
}
export function hookOutput(db,event,report,now=Date.now(),policy=DEFAULTS) {
  const name=event.hook_event_name;
  if(!['PostCompact','PostToolUse','UserPromptSubmit','Stop'].includes(name)) return {};
  const text=takeNotice(db,report,now,policy);
  if(!text) return {};
  if(['PostToolUse','UserPromptSubmit'].includes(name))
    return {hookSpecificOutput:{hookEventName:name,additionalContext:text}};
  return {systemMessage:text};
}
export function takeNotice(db,report,now=Date.now(),policy=DEFAULTS) {
  const s=db.prepare('SELECT * FROM sessions WHERE session=? AND agent=?').get(report.session,report.agent);
  if(!s) return null;
  const seen=new Set(JSON.parse(s.notice_keys)), fresh=report.alerts.filter(a=>!seen.has(a.key));
  const stronger=fresh.some(a=>a.severity==='handoff');
  if(!fresh.length || (!stronger && now-s.last_notice<policy.reminderCooldownSeconds*1000)) return null;
  const text='[上下文与流量监测] '+fresh.map(a=>a.message).join(' ') +
    ' 请在当前操作的安全阶段向用户提醒，并准备精简交接摘要。不要中断事务，不自动切窗，不宣称模型已变笨。';
  db.prepare('UPDATE sessions SET last_notice=?,notice_keys=? WHERE session=? AND agent=?')
    .run(now,JSON.stringify([...seen,...fresh.map(a=>a.key)].slice(-80)),report.session,report.agent);
  return text;
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
  const a=argumentsOf(process.argv.slice(2)), client=a.client??(a.command==='record'?'generic':'codex');
  if(!Object.hasOwn(CLIENTS,client)) throw new Error('supported client required');
  if(a.command==='clients') {process.stdout.write(JSON.stringify(CLIENTS,null,2));return;}
  const stateDir=resolve(a['state-dir']??(client==='codex'?join(homedir(),'.codex','context-traffic-guard-state'):
    join(homedir(),'.context-traffic-guard')));
  const db=openStore(stateDir), policy=loadPolicy(a.policy??
    join(dirname(fileURLToPath(import.meta.url)),'..','integration','policy.json'));
  try {
    if(['hook','record','statusline'].includes(a.command)) {
      const chunks=[];let bytes=0;
      for await(const chunk of process.stdin) {
        bytes+=chunk.length;
        if(bytes>4194304) throw new Error('hook payload too large');
        chunks.push(chunk);
      }
      const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(a.command==='statusline') {
        const snapshot=statusSnapshot(client,raw,{session:a.session??(client==='grok'?process.env.GROK_SESSION_ID:undefined),source:a.source});
        let report=null;
        if(snapshot.session_id) {
          const s=ingest(db,snapshot);
          report=summarize(db,s.session,s.agent,Date.now(),policy);
        }
        process.stdout.write(renderStatus(client,report,snapshot));return;
      }
      if(a.command==='record'&&client!=='generic') throw new Error('record requires generic client');
      const event=normalizeEvent(client,raw,{session:a.session,source:a.source}), s=ingest(db,event);
      const endpoint=a.pipe??a.socket??a.endpoint;
      if(a.sampleTraffic&&endpoint) await sampleTraffic(db,endpoint);
      const original=client==='generic'?raw.event:raw.hook_event_name??raw.hookEventName;
      let output={};
      if(canRemind(client,original)) {
        const report=summarize(db,s.session,s.agent,Date.now(),policy);
        output=reminderOutput(client,original,takeNotice(db,report,Date.now(),policy));
      }
      if(a.command==='record') output={accepted:true,client:client,session_id:event.raw_session,...output};
      process.stdout.write(JSON.stringify(output));
    } else if(a.command==='report') {
      const session=a.session??(client==='codex'?process.env.CODEX_THREAD_ID:undefined);
      if(!session) throw new Error('session required');
      process.stdout.write(JSON.stringify(summarize(db,sessionKey(client,session,a.source),a.agent??'root',Date.now(),policy),null,2));
    } else if(a.command==='list-sessions') {
      process.stdout.write(JSON.stringify(db.prepare('SELECT c.client,c.raw_session session_id,c.source,c.agent,s.activity FROM clients c JOIN sessions s USING(session,agent) WHERE c.client=? ORDER BY s.activity DESC LIMIT 100').all(client),null,2));
    } else throw new Error('use clients, hook, record, statusline, list-sessions or report');
  } finally {db.close();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(()=>{
    if(process.argv[2]==='hook') {
      process.stdout.write('{}');
      process.stderr.write('context-traffic-guard: observation unavailable; task continues.\n');
    } else if(process.argv[2]==='statusline') process.stdout.write('ctg | observation unavailable');
    else {process.stderr.write('context-traffic-guard: command failed.\n');process.exitCode=1;}
  });
}
