import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, basename } from 'node:path';
import { openStore, normalizeUsage, median } from './guard.mjs';

const a={};
for(let i=2;i<process.argv.length;i+=2) a[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!a.rollout) throw new Error('explicit rollout path required');
let compactions=0,unreadable=0,firstSession=null,lastTime=null;
const usage=[],seen=new Set();
for await(const line of createInterface({input:createReadStream(resolve(a.rollout)),crlfDelay:Infinity})) {
  const head=line.slice(0,600), type=/"type"\s*:\s*"([^"]+)"/.exec(head);
  const payload=head.indexOf('"payload"');
  if(!type||(payload>=0&&type.index>payload)) {unreadable++;continue;}
  if(type[1]==='compacted') {compactions++;continue;}
  if(!['session_meta','token_usage_record'].includes(type[1])) continue;
  if(line.length>2097152) {unreadable++;continue;}
  try {
    const e=JSON.parse(line);
    if(e.type==='session_meta'&&!firstSession) firstSession=e.payload?.id??null;
    if(e.type==='token_usage_record') {
      const key=e.payload?.response_id??e.ordinal??e.timestamp;
      const u=normalizeUsage(e.payload?.usage);
      if(u&&!seen.has(key)) {seen.add(key);usage.push(u);lastTime=e.timestamp;}
    }
  } catch {unreadable++;}
}
const report={scope:'top-level records in the explicitly supplied rollout; nested inherited history is excluded',
  session_id:firstSession,compaction_records:compactions,unreadable_records:unreadable,
  file_bytes:statSync(a.rollout).size,recorded_requests:usage.length,last_usage_at:lastTime,
  last_input_tokens:usage.at(-1)?.input??null,
  first_five_input_median:usage.length>=5?median(usage.slice(0,5).map(u=>u.input)):null,
  last_five_input_median:usage.length>=5?median(usage.slice(-5).map(u=>u.input)):null,
  speed:'historical model request timing is not available from these usage records',
};
if(a['state-dir']) {
  if(!a.session||a.session!==firstSession) throw new Error('explicit session must match rollout session metadata');
  const db=openStore(resolve(a['state-dir']));
  try {
    const s=db.prepare('SELECT compact_count FROM sessions WHERE session=? AND agent=?').get(a.session,a.agent??'root');
    if(s&&s.compact_count) throw new Error('seed history before activating hooks to prevent overlap');
    db.prepare('INSERT OR IGNORE INTO sessions(session,agent,started,activity) VALUES(?,?,?,?)')
      .run(a.session,a.agent??'root',Date.now(),Date.now());
    db.prepare('UPDATE sessions SET history_count=?,history_source=? WHERE session=? AND agent=?')
      .run(compactions,basename(a.rollout),a.session,a.agent??'root');
  } finally {db.close();}
}
process.stdout.write(JSON.stringify(report,null,2));
