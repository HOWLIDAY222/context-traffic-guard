import http from 'node:http';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from './guard.mjs';

export function localRequestOptions(target,platform=process.platform) {
  if(typeof target!=='string'||!target) throw new Error('explicit local endpoint required');
  const base={path:'/connections',method:'GET',agent:false};
  if(/^https?:/i.test(target)) {
    const url=new URL(target);
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
      url.username||url.password||url.search||url.hash||url.pathname!=='/')
      throw new Error('plain loopback HTTP endpoint without credentials required');
    return {...base,hostname:url.hostname.replace(/^\[|\]$/g,''),port:url.port||80};
  }
  if(platform==='win32'?!target.startsWith('\\\\.\\pipe\\'):!posix.isAbsolute(target))
    throw new Error('explicit local IPC path required');
  return {...base,socketPath:target};
}
export function readConnections(target,timeout=1500) {
  const options=localRequestOptions(target);
  return new Promise((yes,no)=>{
    const req=http.request(options,res=>{
      let body='',bytes=0;
      res.setEncoding('utf8');
      res.on('data',chunk=>{
        bytes+=Buffer.byteLength(chunk);
        if(bytes>4194304) req.destroy(new Error('response too large'));
        else body+=chunk;
      });
      res.on('error',no);
      res.on('end',()=>{
        clearTimeout(timer);
        if(res.statusCode!==200) return no(new Error('local API unavailable'));
        try {
          const v=JSON.parse(body);
          if(!Number.isSafeInteger(v.uploadTotal)||v.uploadTotal<0||
            !Number.isSafeInteger(v.downloadTotal)||v.downloadTotal<0||!Array.isArray(v.connections))
            throw new Error('unsupported counters');
          yes(v);
        } catch(e) {no(e);}
      });
    });
    const timer=setTimeout(()=>req.destroy(new Error('local API timeout')),timeout);
    req.on('error',e=>{clearTimeout(timer);no(e);});
    req.end();
  });
}
export function advance(previous,snapshot,totals) {
  const next=new Map(), result={...totals};
  for(const c of snapshot.connections) {
    if(typeof c.id!=='string'||!Number.isFinite(c.upload)||!Number.isFinite(c.download)) continue;
    const old=previous.get(c.id);
    const up=Math.max(0,c.upload-(old?.upload??0)), down=Math.max(0,c.download-(old?.download??0));
    result.sampled_up+=up;result.sampled_down+=down;
    if(/^(codex|chatgpt)(\.exe)?$/i.test(c.metadata?.process??'')) {
      result.codex_up+=up;result.codex_down+=down;
    }
    next.set(c.id,{upload:c.upload,download:c.download});
  }
  return {next,totals:result};
}
async function main() {
  const a={};
  for(let i=2;i<process.argv.length;i+=2) a[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
  const endpoint=a.pipe??a.socket??a.endpoint;
  if(!a['state-dir']||!endpoint) throw new Error('state directory and explicit local endpoint required');
  const db=openStore(resolve(a['state-dir']));
  const seconds=Number(a.seconds??30), interval=Number(a['interval-ms']??1000), idle=Number(a['idle-seconds']??0);
  if(!(seconds>0&&seconds<=86400&&interval>=250&&interval<=10000)) throw new Error('invalid sampling bounds');
  const stopAt=Date.now()+seconds*1000;
  let first=null, previous=null, last=null, segment=randomUUID(), samples=0, failures=0,resets=0;
  let totals={codex_up:0,codex_down:0,sampled_up:0,sampled_down:0};
  try {
    while(Date.now()<stopAt) {
      if(a.lease) {
        const row=db.prepare('SELECT value FROM runtime WHERE key=\'watcher\'').get();
        if(!row||JSON.parse(row.value).token!==a.lease) break;
        db.prepare('UPDATE runtime SET value=? WHERE key=\'watcher\'')
          .run(JSON.stringify({token:a.lease,heartbeat:Date.now()}));
      }
      if(idle) {
        const recent=db.prepare('SELECT max(activity) value FROM sessions').get().value??0;
        const pending=db.prepare('SELECT count(*) n FROM requests WHERE status=\'pending\' AND started>?').get(Date.now()-3600000).n;
        if(!pending&&Date.now()-recent>idle*1000) break;
      }
      try {
        const snap=await readConnections(endpoint);
        if(last&&(snap.uploadTotal<last.uploadTotal||snap.downloadTotal<last.downloadTotal)) {
          resets++;
          segment=randomUUID();previous=null;totals={codex_up:0,codex_down:0,sampled_up:0,sampled_down:0};
        }
        if(!previous) {
          previous=new Map(snap.connections.filter(c=>typeof c.id==='string').map(c=>[c.id,{upload:c.upload,download:c.download}]));
        } else {
          const step=advance(previous,snap,totals);previous=step.next;totals=step.totals;
        }
        const ts=Date.now();
        db.prepare('INSERT INTO traffic(ts,segment,kernel_up,kernel_down,codex_up,codex_down,sampled_up,sampled_down,source) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(ts,segment,snap.uploadTotal,snap.downloadTotal,totals.codex_up,totals.codex_down,
            totals.sampled_up,totals.sampled_down,'mihomo_local_api');
        first??={ts,up:snap.uploadTotal,down:snap.downloadTotal};
        last={ts,up:snap.uploadTotal,down:snap.downloadTotal,uploadTotal:snap.uploadTotal,downloadTotal:snap.downloadTotal};
        samples++;
      } catch {failures++;}
      if(samples%60===0) db.prepare('DELETE FROM traffic WHERE ts<?').run(Date.now()-7200000);
      await new Promise(r=>setTimeout(r,failures&&!samples?Math.min(interval*5,5000):interval));
    }
  } finally {
    if(a.lease) {
      const row=db.prepare('SELECT value FROM runtime WHERE key=\'watcher\'').get();
      if(row&&JSON.parse(row.value).token===a.lease) db.prepare('DELETE FROM runtime WHERE key=\'watcher\'').run();
    }
    db.close();
  }
  if(!a.lease) process.stdout.write(JSON.stringify({
    samples,failures,resets,seconds:first&&last?(last.ts-first.ts)/1000:null,
    kernel_upload_bytes:first&&last&&!resets?last.up-first.up:null,
    kernel_download_bytes:first&&last&&!resets?last.down-first.down:null,
    codex_chatgpt_upload_lower_bound:totals.codex_up,
    scope:'all local Mihomo traffic; process sampling spans all chats; short closed connections may be missed',
  },null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{process.stderr.write('traffic sampler unavailable.\n');process.exitCode=1;});
