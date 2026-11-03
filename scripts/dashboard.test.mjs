import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { openStore, ingest, loadPolicy, storeSystemSnapshot } from './guard.mjs';
import { normalizeEvent } from './adapters.mjs';
import { withStore, sessionsIn, sessionData, readHandoffSeed, decodeSelection } from './dashboard-data.mjs';
import { createDashboard } from './dashboard.mjs';
import { makeHandoff } from '../dashboard/src/format.mjs';

const policy=loadPolicy(), now=Date.UTC(2026,10,4,0,0,0);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'ctg-panel-')), db=openStore(dir);
  t.after(()=>db.close());
  function feed(payload,at=now) {ingest(db,normalizeEvent('generic',{version:1,session_id:'same',...payload},{source:'test'}),at,at);}
  feed({event:'session.started'});
  return {dir,db,feed,key:sessionsIn(db)[0].key};
}
test('panel reads preserve the database and never consume pending reminder state',t=>{
  const {dir,db,feed,key}=fixture(t);
  feed({event:'compaction.completed',event_id:'one'});feed({event:'compaction.completed',event_id:'two'});
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const path=join(dir,'metrics.sqlite'),digest=()=>createHash('sha256').update(readFileSync(path)).digest('hex'),before=digest();
  const result=withStore(dir,reader=>sessionData(reader,key,30,now,policy));
  assert.equal(result.ok,true);assert.equal(result.report.compactions.known_total,2);
  assert.equal(digest(),before);
  assert.equal(db.prepare('SELECT last_notice FROM sessions').get().last_notice,0);
});
test('empty paths stay empty rather than creating a database or invented observations',()=>{
  const dir=join(mkdtempSync(join(tmpdir(),'ctg-empty-')),'uncreated');
  assert.equal(withStore(dir,()=>{}).code,'no_database');assert(!existsSync(dir));
});
test('session selection isolates identical IDs across clients, sources and agents',t=>{
  const {dir,db,feed,key}=fixture(t);
  feed({event:'request.finished',request_id:'a',status:'completed',elapsed_ms:10,usage:{input_tokens:100,output_tokens:70}});
  ingest(db,normalizeEvent('generic',{version:1,event:'request.finished',session_id:'same',request_id:'a',status:'completed',usage:{input_tokens:777,output_tokens:90}},{source:'other'}),now,now);
  ingest(db,normalizeEvent('claude',{session_id:'same',hook_event_name:'SessionStart'}),now,now);
  ingest(db,normalizeEvent('generic',{version:1,event:'session.started',session_id:'same',agent_id:'sub'},{source:'test'}),now,now);
  const sessions=sessionsIn(db);assert.equal(sessions.length,4);assert.equal(new Set(sessions.map(s=>s.key)).size,4);
  assert.equal(withStore(dir,reader=>sessionData(reader,key,0,now,policy)).report.tokens.latest_input,100);
  assert.throws(()=>decodeSelection('../metrics.sqlite'));assert.throws(()=>decodeSelection(Buffer.from(JSON.stringify(['wrong'])).toString('base64url')));
});
test('rate chart excludes non-comparable models, timings and failed requests',t=>{
  const {db,feed,key}=fixture(t);
  for(let i=0;i<12;i++) feed({event:'request.finished',request_id:'r'+i,model:i===2?'other':'model',status:i===3?'failed':'completed',elapsed_ms:1000,usage:{input_tokens:1000,cached_input_tokens:0,output_tokens:100,reasoning_output_tokens:0}},now+i*1000);
  const data=sessionData(db,key,30,now+12000,policy);
  assert.equal(data.history.requests.length,12);assert.equal(data.history.rates.length,10);
  assert.equal(data.report.speed.status,'measured_request_end_to_end');
  assert(data.history.rates.every(r=>r.value===100));
});
test('history is time-filtered, bounded and never makes snapshots into request samples',t=>{
  const {db,feed,key}=fixture(t);
  feed({event:'request.finished',request_id:'old',status:'completed'},now-3*3600000);
  for(let i=0;i<505;i++) feed({event:'request.finished',request_id:'new'+i,status:'completed'},now+i);
  const data=sessionData(db,key,30,now+1000,policy);
  assert.equal(data.history.total_requests,505);assert.equal(data.history.requests.length,500);assert(data.history.truncated);
  ingest(db,normalizeEvent('claude',{session_id:'snapshot-only',hook_event_name:'SessionStart'}),now,now);
  const s=sessionsIn(db).find(s=>s.client==='claude');
  assert.equal(sessionData(db,s.key,0,now,policy).history.requests.length,0);
});
test('network series uses the current source and reset segment only, within the traffic window',t=>{
  const {db,key}=fixture(t),sample=(name,u,d,ts)=>storeSystemSnapshot(db,{platform:'linux',name,uploadTotal:u,downloadTotal:d},ts);
  sample('eth0',100,200,now-5000);sample('eth0',1000,2000,now-4000);
  sample('tun0',500,600,now-3000);sample('tun0',5,6,now-2000);sample('tun0',15,26,now-1000);
  const data=sessionData(db,key,0,now,policy);
  assert.equal(data.report.traffic.interface,'tun0');assert.equal(data.history.traffic.length,1);
  assert.equal(data.history.traffic[0].upload_per_second,10);assert.equal(data.history.traffic[0].download_per_second,20);
  assert.equal(sessionData(db,key,0,now+3600000,policy).history.traffic.length,0);
});
test('Agent handoff file is explicit, size limited and bound to the selected client/source/session',t=>{
  const {dir,db}=fixture(t),selection=sessionsIn(db)[0],path=join(dir,'brief.json');
  const raw={version:1,client:'generic',source:'test',session_id:'same',fields:{goal:'Finish the approved task',completed:'Verified result',unexpected:'ignored'}};
  writeFileSync(path,JSON.stringify(raw));
  assert.deepEqual(readHandoffSeed(path,selection).fields,{goal:raw.fields.goal,completed:'Verified result'});
  assert.equal(readHandoffSeed(path,{...selection,client:'codex'}).status,'different_session');
  assert.equal(readHandoffSeed(path,{...selection,source:'other'}).status,'different_session');
  writeFileSync(path,'x'.repeat(65537));assert.equal(readHandoffSeed(path,selection).status,'invalid');
});
test('handoff export includes editable task facts, source, unknowns and measured traffic scope',t=>{
  const {db,key,feed}=fixture(t);feed({event:'compaction.completed',event_id:'one'});
  const data={...sessionData(db,key,30,now,policy),generated_at:now};
  const md=makeHandoff(data,{goal:'Approved goal',completed:'Verified build',next:'One remaining action'});
  assert(md.includes('Approved goal'));assert(md.includes('Verified build'));assert(md.includes('One remaining action'));
  assert(md.includes('same'));assert(md.includes('未知'));assert(md.includes('未提供，请在交接前补充'));
  assert(!md.includes('undefined'));assert(!md.includes('NaN'));assert(!md.includes('Infinity'));
});
test('HTTP panel serves real data and assets, rejects other origins and accepts no writes',async t=>{
  const {dir}=fixture(t),assets=join(dir,'assets');mkdirSync(assets);writeFileSync(join(assets,'index.html'),'<title>Local panel</title>');
  const server=createDashboard({stateDir:dir,policy,assetsDir:assets});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port;
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());assert.equal(boot.ok,true);assert.equal(boot.sessions.length,1);assert.equal(boot.initial_key,null);
  const response=await fetch(url+'/api/session?minutes=30&key='+boot.sessions[0].key);assert.equal(response.status,200);assert((await response.json()).report);
  assert((await fetch(url).then(r=>r.text())).includes('Local panel'));
  assert.equal((await fetch(url+'/api/bootstrap',{headers:{Origin:'https://elsewhere.example'}})).status,403);
  const differentHost=await new Promise((resolve,reject)=>{
    const req=request(url+'/api/bootstrap',{headers:{Host:'elsewhere.example'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(differentHost,403);
  assert.equal((await fetch(url+'/api/bootstrap',{method:'POST',body:'change'})).status,405);
  assert.equal((await fetch(url+'/api/session?key=nope&minutes=-1')).status,400);
  assert.equal((await fetch(url+'/not-exposed.sqlite')).status,404);
});
test('explicit launch selection binds the requested agent and never picks another same-ID client',async t=>{
  const {dir}=fixture(t),server=createDashboard({stateDir:dir,policy,initial:{client:'claude',session:'same'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const boot=await fetch('http://127.0.0.1:'+server.address().port+'/api/bootstrap').then(r=>r.json());
  assert.equal(boot.initial_key,null);assert.equal(boot.initial_unmatched,true);
});
test('distributed interface serves its actual compiled scripts, styles and license notices without build tools',async t=>{
  const {dir}=fixture(t),server=createDashboard({stateDir:dir,policy});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port,html=await fetch(url).then(r=>r.text());
  assert(html.includes('Context Guard'));
  const assets=[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]).filter(p=>p.startsWith('./assets/'));
  assert(assets.some(p=>p.endsWith('.js')));assert(assets.some(p=>p.endsWith('.css')));
  for(const path of assets) {
    const response=await fetch(new URL(path,url));assert.equal(response.status,200);assert((await response.text()).length>100);
    assert(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
  }
  const license=await fetch(url+'/third-party-notices.txt');assert.equal(license.status,200);assert((await license.text()).includes('MIT'));
});
