import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { openStore, ingest, summarize, hookOutput, normalizeUsage, storeTrafficSnapshot, DEFAULTS } from './guard.mjs';
import { advance, readConnections } from './traffic.mjs';

const epoch=1800000000000;
const event=(name,extra={})=>({session_id:'test-session',hook_event_name:name,turn_id:'turn',model:'test-model',...extra});
function store() {
  const dir=mkdtempSync(join(tmpdir(),'context-guard-test-'));
  return {dir,db:openStore(dir)};
}
function request(db,index,{input=10000,output=128,cached=8000,reasoning=0,elapsed=1000,model='test-model'}={}) {
  const now=epoch+index*10000;
  ingest(db,event('PreModelRequest',{model}),now,index*10000);
  ingest(db,event('PostModelRequest',{model,status:'completed',token_usage:{
    input_tokens:input,output_tokens:output,cached_input_tokens:cached,reasoning_output_tokens:reasoning,
  }}),now+elapsed,index*10000+elapsed);
}
test('completed compactions survive reopen; duplicate and unpaired posts are not invented completions',()=>{
  const {dir,db}=store();
  ingest(db,event('PreCompact'));ingest(db,event('PreCompact'));
  ingest(db,event('PostCompact'));ingest(db,event('PostCompact'));db.close();
  const again=openStore(dir), r=summarize(again,'test-session');
  assert.equal(r.compactions.known_total,1);
  assert.equal(r.compactions.unpaired_postcompact_events,1);
  assert.equal(r.compactions.coverage,'since_activation_only');again.close();
});
test('subagent compactions do not inflate the root thread counter',()=>{
  const {db}=store();
  ingest(db,event('PreCompact',{agent_id:'child'}));ingest(db,event('PostCompact',{agent_id:'child'}));
  assert.equal(summarize(db,'test-session','child').compactions.known_total,1);
  assert.equal(summarize(db,'test-session').status,'no_observations');db.close();
});
test('cache is a subset and absent usage remains unknown',()=>{
  assert.equal(normalizeUsage(null),null);
  assert.deepEqual(normalizeUsage({input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:80}}),
    {input:100,output:10,cached:80,reasoning:null,total:110});
  assert.equal(normalizeUsage({input_tokens:100,output_tokens:10,cached_input_tokens:1000}).cached,null);
  const {db}=store();
  ingest(db,event('PostModelRequest',{status:'completed'}),epoch);
  const r=summarize(db,'test-session');
  assert.equal(r.tokens.latest_input,null);
  assert.equal(r.tokens.account_quota_remaining,null);db.close();
});
test('request timing excludes gaps between requests, detects comparable sustained slowdown',()=>{
  const {db}=store();
  for(let i=0;i<10;i++) request(db,i,{elapsed:i<5?1000:2000});
  const r=summarize(db,'test-session','root',epoch+200000);
  assert.equal(r.speed.ratio,0.5);
  assert.equal(r.speed.baseline_request_ms,1000);
  assert.equal(r.speed.recent_request_ms,2000);
  assert.equal(r.speed.ttft_ms,null);
  assert(r.alerts.some(a=>a.kind==='request_speed'));db.close();
});
test('different model or request sizes do not masquerade as model slowdown',()=>{
  const {db}=store();
  for(let i=0;i<5;i++)request(db,i);
  for(let i=5;i<10;i++)request(db,i,{input:100000,elapsed:10000});
  let r=summarize(db,'test-session');
  assert.equal(r.speed.status,'insufficient_comparable_samples');
  assert(r.alerts.some(a=>a.kind==='token_growth'));
  for(let i=10;i<15;i++)request(db,i,{model:'another-model',elapsed:20000});
  r=summarize(db,'test-session');
  assert(!r.alerts.some(a=>a.kind==='request_speed'));db.close();
});
test('overlapping unidentifiable requests retain counts but do not fabricate latency',()=>{
  const {db}=store();
  ingest(db,event('PreModelRequest'),epoch,0);
  ingest(db,event('PreModelRequest'),epoch+1,1);
  ingest(db,event('PostModelRequest',{status:'completed',token_usage:{input_tokens:100,output_tokens:100}}),epoch+500,500);
  const r=summarize(db,'test-session');
  assert.equal(r.requests.timed,0);db.close();
});
test('alerts are advisory, never block Stop, and do not repeat unchanged warnings',()=>{
  const {db}=store();
  for(let i=0;i<2;i++) {ingest(db,event('PreCompact'),epoch+i*2);ingest(db,event('PostCompact'),epoch+i*2+1);}
  const r=summarize(db,'test-session');
  const output=hookOutput(db,event('Stop'),r,epoch+10000);
  assert(output.systemMessage);
  assert(!('decision' in output));assert(!('continue' in output));
  assert.deepEqual(hookOutput(db,event('Stop'),r,epoch+3600000),{});
  assert.deepEqual(hookOutput(db,event('PostModelRequest'),r,epoch+3600000),{});db.close();
});
test('a newly stronger handoff signal is not delayed by the ordinary cooldown',()=>{
  const {db}=store();
  for(let i=0;i<2;i++) {ingest(db,event('PreCompact'),epoch+i*2);ingest(db,event('PostCompact'),epoch+i*2+1);}
  hookOutput(db,event('Stop'),summarize(db,'test-session'),epoch+10000);
  for(let i=2;i<10;i++) {ingest(db,event('PreCompact'),epoch+i*2);ingest(db,event('PostCompact'),epoch+i*2+1);}
  const out=hookOutput(db,event('PostToolUse'),summarize(db,'test-session'),epoch+11000);
  assert(out.hookSpecificOutput.additionalContext.includes('10'));
  db.close();
});
test('traffic is counter deltas, reset-safe, and explicitly spans all chats',()=>{
  const {db}=store();ingest(db,event('SessionStart'),epoch);
  const insert=db.prepare('INSERT INTO traffic(ts,segment,kernel_up,kernel_down,codex_up,codex_down,sampled_up,sampled_down,source) VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(epoch,'old',9000,8000,1000,1000,1000,1000,'test');
  insert.run(epoch+1000,'new',10,20,0,0,0,0,'test');
  insert.run(epoch+2000,'new',110,220,40,50,50,80,'test');
  const r=summarize(db,'test-session','root',epoch+2000);
  assert.equal(r.traffic.kernel_upload_bytes,100);
  assert.equal(r.traffic.codex_chatgpt_upload_lower_bound,40);
  assert(r.traffic.scope.includes('all chats'));
  assert.equal(summarize(db,'test-session','root',epoch+20000).traffic.status,'stale');db.close();
});
test('sampler handles existing and new connections without attributing other processes to Codex',()=>{
  const step=advance(new Map([['a',{upload:100,download:100}]]),{connections:[
    {id:'a',upload:150,download:120,metadata:{process:'codex.exe'}},
    {id:'b',upload:1000,download:3000,metadata:{process:'browser.exe'}},
  ]},{codex_up:0,codex_down:0,sampled_up:0,sampled_down:0});
  assert.equal(step.totals.codex_up,50);
  assert.equal(step.totals.sampled_up,1050);
});
test('raw prompts, tool outputs, and error messages are not persisted',()=>{
  const {dir,db}=store(), marker='DO_NOT_STORE_PRIVATE_PAYLOAD';
  ingest(db,event('UserPromptSubmit',{prompt:marker}),epoch);
  ingest(db,event('PostToolUse',{tool_response:marker}),epoch);
  ingest(db,event('PostModelRequest',{status:'failed',error:'429 '+marker}),epoch);
  assert.equal(db.prepare('SELECT error_category FROM requests').get().error_category,'rate_limit');
  db.close();
  for(const name of ['metrics.sqlite','metrics.sqlite-wal']) if(existsSync(join(dir,name)))
    assert(!readFileSync(join(dir,name)).includes(Buffer.from(marker)));
});
test('local API collector is timeout-bounded and checks response status',async()=>{
  const pipe=process.platform==='win32'?'\\\\.\\pipe\\context-guard-test-'+process.pid:join(tmpdir(),'context-guard-'+process.pid+'.sock');
  let mode='ok';
  const server=http.createServer((req,res)=>{
    if(mode==='hang')return;
    if(mode==='denied') {res.writeHead(401);res.end('{}');return;}
    res.end(JSON.stringify({uploadTotal:10,downloadTotal:20,connections:[]}));
  });
  await new Promise(r=>server.listen(pipe,r));
  try {
    assert.equal((await readConnections(pipe)).uploadTotal,10);
    mode='denied';await assert.rejects(readConnections(pipe));
    mode='hang';await assert.rejects(readConnections(pipe,50));
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('a broken hook input fails open with valid empty JSON',()=>{
  const {dir,db}=store();db.close();
  const r=spawnSync(process.execPath,['--no-warnings',fileURLToPath(new URL('./guard.mjs',import.meta.url)),'hook','--state-dir',dir],
    {input:'not-json',encoding:'utf8'});
  assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{});
});
test('event-based traffic counters persist, reject old samples and reset without negative bytes',()=>{
  const {dir,db}=store();ingest(db,event('SessionStart'),epoch);
  storeTrafficSnapshot(db,{uploadTotal:100,downloadTotal:200,connections:[]},epoch);
  storeTrafficSnapshot(db,{uploadTotal:300,downloadTotal:500,connections:[]},epoch+1000);
  storeTrafficSnapshot(db,{uploadTotal:1,downloadTotal:1,connections:[]},epoch-100);
  assert.equal(summarize(db,'test-session','root',epoch+1000).traffic.kernel_upload_bytes,200);
  db.close();
  const next=openStore(dir);
  storeTrafficSnapshot(next,{uploadTotal:10,downloadTotal:20,connections:[]},epoch+2000);
  storeTrafficSnapshot(next,{uploadTotal:60,downloadTotal:80,connections:[]},epoch+3000);
  const r=summarize(next,'test-session','root',epoch+3000);
  assert.equal(r.traffic.kernel_upload_bytes,50);
  assert.equal(r.traffic.source,'mihomo_event_sample');
  next.close();
});
