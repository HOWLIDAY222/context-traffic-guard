import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {CLIENTS,normalizeEvent,statusSnapshot,sessionKey,canRemind,reminderOutput,renderStatus} from './adapters.mjs';
import {openStore,ingest,summarize,normalizeUsage,takeNotice} from './guard.mjs';
import {buildConfig} from './configure.mjs';

const epoch=1800000000000;
const store=()=>{const dir=mkdtempSync(join(tmpdir(),'ctg-adapter-'));return {dir,db:openStore(dir)};};
const raw=(name,extra={})=>({session_id:'same-id',hook_event_name:name,...extra});
function feed(db,client,payload,n=0,options={}) {
  const event=normalizeEvent(client,payload,options);ingest(db,event,epoch+n,n);return event;
}
const report=(db,client,n=10000,source)=>summarize(db,sessionKey(client,'same-id',source),'root',epoch+n);

test('the same session id in five clients never mixes compactions or requests',()=>{
  const {db}=store();
  for(const client of Object.keys(CLIENTS)) {
    const payload=client==='generic'?{version:1,session_id:'same-id',event:'session.started'}:raw('SessionStart');
    feed(db,client,payload);
  }
  feed(db,'claude',raw('PreCompact'));feed(db,'claude',raw('PostCompact'));
  assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,5);
  assert.equal(report(db,'claude').compactions.known_total,1);
  assert.equal(report(db,'codex').compactions.known_total,0);
  assert.notEqual(sessionKey('generic','same-id','a'),sessionKey('generic','same-id','b'));
  db.close();
});

test('Claude status snapshots include cache reads and writes without inventing request counts or cumulative consumption',()=>{
  const {db}=store();
  const snapshot=statusSnapshot('claude',{session_id:'same-id',model:{id:'claude-test'},context_window:{
    used_percentage:8,context_window_size:200000,total_input_tokens:15500,total_output_tokens:1200,
    current_usage:{input_tokens:8500,cache_creation_input_tokens:5000,cache_read_input_tokens:2000,output_tokens:1200}}});
  for(let i=0;i<10;i++) ingest(db,snapshot,epoch+i,i);
  const r=report(db,'claude');
  assert.equal(r.tokens.latest_input,15500);assert.equal(r.tokens.latest_cached_input,2000);
  assert.equal(r.tokens.completed_requests,0);assert.equal(r.tokens.recorded_total,null);
  assert.equal(r.context.input_tokens,15500);assert.equal(r.context.used_percentage,8);
  assert.equal(r.requests.timed,0);assert.equal(r.tokens.account_quota_remaining,null);
  db.close();
});

test('a cleared Claude context cannot retain stale token or percentage values',()=>{
  const {db}=store();
  ingest(db,statusSnapshot('claude',{session_id:'same-id',context_window:{used_percentage:85,current_usage:{input_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:2}}}),epoch);
  ingest(db,statusSnapshot('claude',{session_id:'same-id',context_window:{used_percentage:null,current_usage:null}}),epoch+1);
  const r=report(db,'claude');assert.equal(r.tokens.latest_input,null);assert.equal(r.context.used_percentage,null);
  assert(!r.alerts.some(a=>a.kind==='context_pressure'));db.close();
});

test('Gemini compression triggers are not reported as completed compactions',()=>{
  const {db}=store();
  feed(db,'gemini',raw('PreCompress'));feed(db,'gemini',raw('PreCompress'),1);
  const r=report(db,'gemini');
  assert.equal(r.compactions.triggered_since_activation,2);
  assert.equal(r.compactions.known_total,null);assert.equal(r.compactions.completed_since_activation,null);
  assert(r.alerts.some(a=>a.message.includes('完成次数未知')));db.close();
});

test('Gemini stream chunks update one pending request and only a finish marker supplies a generation window',()=>{
  const {db}=store(), request={model:'gemini-test'};
  feed(db,'gemini',raw('BeforeModel',{llm_request:request}),0);
  const chunk=(usage,candidates=[])=>raw('AfterModel',{llm_request:request,llm_response:{usageMetadata:usage,candidates}});
  feed(db,'gemini',chunk({promptTokenCount:100,candidatesTokenCount:12,totalTokenCount:112}),100);
  feed(db,'gemini',chunk({promptTokenCount:100,candidatesTokenCount:24,totalTokenCount:124}),200);
  assert.equal(report(db,'gemini').requests.timed,0);
  feed(db,'gemini',chunk({promptTokenCount:100,candidatesTokenCount:128,totalTokenCount:228},[{finishReason:'STOP'}]),1000);
  let r=report(db,'gemini');
  assert.equal(r.requests.observed_attempts,1);assert.equal(r.tokens.recorded_total,228);
  assert.equal(r.tokens.latest_output,128);assert.equal(r.requests.timed,1);
  feed(db,'gemini',chunk({totalTokenCount:230}),1100);
  r=report(db,'gemini');
  assert.equal(r.tokens.recorded_total,228);assert.equal(r.tokens.latest_total,230);
  assert.equal(r.tokens.latest_input,null);assert.equal(r.requests.observed_attempts,1);
  db.close();
});

test('missing or ambiguous Gemini finish boundaries do not fabricate completed requests',()=>{
  const {db}=store(), request={model:'gemini-test'};
  feed(db,'gemini',raw('BeforeModel',{llm_request:request}),0);
  feed(db,'gemini',raw('BeforeModel',{llm_request:request}),1);
  feed(db,'gemini',raw('AfterModel',{llm_request:request,llm_response:{usageMetadata:{totalTokenCount:100},candidates:[{finishReason:'STOP'}]}}),1000);
  const r=report(db,'gemini');assert.equal(r.requests.timed,0);assert.equal(r.tokens.completed_requests,0);
  assert.equal(r.tokens.latest_total,100);assert.equal(r.tokens.latest_input,null);db.close();
});

test('an unresolved Gemini turn cannot poison the next request with a stale pending match',()=>{
  const {db}=store(), request={model:'gemini-test'};
  feed(db,'gemini',raw('BeforeModel',{llm_request:request}),0);
  feed(db,'gemini',raw('AfterAgent'),1000);
  let r=report(db,'gemini');assert.equal(r.requests.unresolved,1);assert.equal(r.requests.pending,0);
  feed(db,'gemini',raw('BeforeModel',{llm_request:request}),2000);
  feed(db,'gemini',raw('AfterModel',{llm_request:request,llm_response:{usageMetadata:{promptTokenCount:100,candidatesTokenCount:128},candidates:[{finishReason:'STOP'}]}}),3000);
  r=report(db,'gemini');assert.equal(r.requests.timed,1);assert.equal(r.tokens.completed_requests,1);db.close();
});

test('Grok camelCase hooks count compactions but ignore undocumented token fields',()=>{
  const {db}=store();
  for(const hookEventName of ['SessionStart','PreCompact','PostCompact'])
    feed(db,'grok',{sessionId:'same-id',hookEventName,token_usage:{input_tokens:100,output_tokens:100}});
  const r=report(db,'grok');assert.equal(r.compactions.known_total,1);
  assert.equal(r.tokens.latest_input,null);assert.equal(r.requests.timed,0);
  assert.equal(canRemind('grok','PostToolUse'),false);db.close();
});

test('an unbound Grok statusline can show context pressure but cannot pollute any session',()=>{
  const snapshot=statusSnapshot('grok',{model:{display_name:'Grok'},context_window:{used_percentage:85}});
  assert.equal(snapshot.session_id,null);assert.equal(snapshot.raw_session,null);
  assert(renderStatus('grok',null,snapshot).includes('unbound'));
  assert(renderStatus('grok',null,snapshot).includes('handoff'));
  const bound=statusSnapshot('grok',{context_window:{used_percentage:85}},{session:'same-id'});
  const {db}=store();ingest(db,bound,epoch);
  assert.equal(report(db,'grok').context.used_percentage,85);db.close();
});

test('generic API correlates concurrent request ids, accepts reported latency and deduplicates replay',()=>{
  const {db}=store();
  const event=(event,extra={})=>({version:1,session_id:'same-id',event,model:'custom',...extra});
  feed(db,'generic',event('request.started',{request_id:'a'}),0);
  feed(db,'generic',event('request.started',{request_id:'b'}),1);
  feed(db,'generic',event('request.started',{request_id:'a'}),2);
  const end=event('request.finished',{request_id:'a',status:'completed',elapsed_ms:500,usage:{input_tokens:100,output_tokens:128}});
  feed(db,'generic',end,1000);feed(db,'generic',end,1100);
  const r=report(db,'generic');assert.equal(r.requests.observed_attempts,2);assert.equal(r.requests.timed,1);
  assert.equal(r.tokens.completed_requests,1);assert.equal(r.tokens.recorded_total,228);
  assert.equal(db.prepare("SELECT timing_kind FROM requests WHERE external_id='a'").get().timing_kind,'caller_reported');
  assert.throws(()=>normalizeEvent('generic',event('request.finished')));db.close();
});

test('generic completed-compaction event ids prevent duplicate counting',()=>{
  const {db}=store();
  const payload={version:1,session_id:'same-id',event:'compaction.completed',event_id:'compact-1'};
  feed(db,'generic',payload);feed(db,'generic',payload,1);
  assert.equal(report(db,'generic').compactions.known_total,1);
  assert.throws(()=>feed(db,'generic',{...payload,event_id:undefined}));db.close();
});

test('oversized generic request ids are rejected rather than truncated into collisions',()=>{
  const payload={version:1,session_id:'s',event:'request.started',request_id:'a'.repeat(201)};
  assert.throws(()=>normalizeEvent('generic',payload));
});

test('partial token metadata stays partial and never turns missing breakdowns into zero',()=>{
  assert.deepEqual(normalizeUsage({total_tokens:90}),{input:null,output:null,cached:null,reasoning:null,total:90});
  const event=normalizeEvent('gemini',raw('AfterModel',{llm_response:{usageMetadata:{totalTokenCount:90}}}));
  assert.equal(event.token_usage.input_tokens,null);assert.equal(event.token_usage.output_tokens,null);
  assert.equal(normalizeUsage(event.token_usage).total,90);
});

test('Gemini extended usage includes reported thoughts and tool input, while unspecified or multi-candidate boundaries stay unfinished',()=>{
  const payload=raw('AfterModel',{llm_request:{model:'gemini-test'},llm_response:{
    usageMetadata:{promptTokenCount:100,toolUsePromptTokenCount:10,candidatesTokenCount:128,thoughtsTokenCount:50,cachedContentTokenCount:80,totalTokenCount:288},
    candidates:[{finishReason:'FINISH_REASON_UNSPECIFIED'}]}});
  let event=normalizeEvent('gemini',payload);
  assert.equal(event.token_usage.input_tokens,110);assert.equal(event.token_usage.output_tokens,178);
  assert.equal(event.token_usage.reasoning_output_tokens,50);assert.equal(event.generation_finished,false);
  payload.llm_response.candidates[0].finishReason='STOP';payload.llm_request.config={candidateCount:2};
  event=normalizeEvent('gemini',payload);assert.equal(event.generation_finished,false);
});

test('client-specific reminder outputs never block and ignored channels do not consume a notice',()=>{
  const {db}=store();
  for(let i=0;i<2;i++) {feed(db,'claude',raw('PreCompact'),i*2);feed(db,'claude',raw('PostCompact'),i*2+1);}
  assert.equal(canRemind('claude','PostCompact'),false);
  const message=takeNotice(db,report(db,'claude'),epoch+10000);
  const claude=reminderOutput('claude','UserPromptSubmit',message);
  assert(claude.hookSpecificOutput.additionalContext);
  const gemini=reminderOutput('gemini','BeforeAgent',message);
  assert(gemini.hookSpecificOutput.additionalContext);assert(!('hookEventName' in gemini.hookSpecificOutput));
  for(const output of [claude,gemini,reminderOutput('generic','checkpoint',message),reminderOutput('grok','Stop',message)]) {
    assert(!('decision' in output));assert(!('continue' in output));
  }
  assert.equal(takeNotice(db,report(db,'claude'),epoch+10001),null);db.close();
});

test('client adapters persist no raw prompts, summaries, tool bodies or statusline personal fields',()=>{
  const {db,dir}=store(), marker='PRIVATE_DATA_NEVER_PERSIST';
  for(const client of ['claude','gemini','grok']) {
    feed(db,client,raw('UserPromptSubmit',{prompt:marker,compact_summary:marker,tool_response:marker}));
    if(client!=='gemini') ingest(db,statusSnapshot(client,{session_id:'same-id',cwd:marker,cost:{details:marker},context_window:{used_percentage:20}}));
  }
  db.close();
  for(const file of ['metrics.sqlite','metrics.sqlite-wal']) if(existsSync(join(dir,file)))
    assert(!readFileSync(join(dir,file)).includes(Buffer.from(marker)));
});

test('config generator uses correct event sets, timeout units and opt-in detailed model hooks',()=>{
  const options={skillDir:'/skill',stateDir:'/state',node:'node'};
  assert(!buildConfig({...options,client:'claude'}).hooks.PreModelRequest);
  const gemini=buildConfig({...options,client:'gemini'});
  assert(!gemini.hooks.AfterModel);assert.equal(gemini.hooks.PreCompress[0].hooks[0].timeout,3000);
  assert(buildConfig({...options,client:'gemini',detailed:true}).hooks.AfterModel);
  assert.equal(buildConfig({...options,client:'grok'}).hooks.Stop[0].hooks[0].timeout,3);
  assert(buildConfig({...options,client:'grok',mode:'statusline'}).startsWith('[ui.status_line]'));
  assert(buildConfig({...options,client:'claude',mode:'statusline'}).statusLine.command.includes('--client claude'));
  assert.throws(()=>buildConfig({...options,client:'claude',skillDir:'/bad/$(command)'}));
  assert.throws(()=>buildConfig({...options,client:'claude',node:'C:/Program Files/node.exe'}));
  assert(buildConfig({...options,client:'claude',node:'C:/Program Files/node.exe',shell:'powershell'}).hooks.Stop[0].hooks[0].command.startsWith('& "'));
});

test('generic CLI records and reports events without any agent SDK or model call',()=>{
  const {db,dir}=store();db.close();
  const script=fileURLToPath(new URL('./guard.mjs',import.meta.url));
  const invoke=(command,input,extra=[])=>spawnSync(process.execPath,['--no-warnings',script,command,
    '--client','generic','--state-dir',dir,...extra],{input:JSON.stringify(input),encoding:'utf8'});
  const payload={version:1,session_id:'same-id',event:'request.finished',request_id:'r',status:'completed',
    elapsed_ms:1000,model:'custom',usage:{input_tokens:100,output_tokens:128}};
  const recorded=invoke('record',payload);assert.equal(recorded.status,0);assert(JSON.parse(recorded.stdout).accepted);
  const result=invoke('report',null,['--session','same-id']);assert.equal(result.status,0);
  const r=JSON.parse(result.stdout);assert.equal(r.tokens.latest_input,100);assert.equal(r.requests.timed,1);
});

test('broken hooks and statusline input fail open across supported clients',()=>{
  const {db,dir}=store();db.close();
  const script=fileURLToPath(new URL('./guard.mjs',import.meta.url));
  for(const client of ['claude','gemini','grok']) {
    const result=spawnSync(process.execPath,['--no-warnings',script,'hook','--client',client,'--state-dir',dir],{input:'bad-json',encoding:'utf8'});
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{});
  }
  const result=spawnSync(process.execPath,['--no-warnings',script,'statusline','--client','grok','--state-dir',dir],{input:'bad-json',encoding:'utf8'});
  assert.equal(result.status,0);assert(result.stdout.includes('unavailable'));
});

test('legacy numeric state survives additive schema migration',()=>{
  const {db,dir}=store();
  ingest(db,{session_id:'legacy',hook_event_name:'PreCompact'});
  ingest(db,{session_id:'legacy',hook_event_name:'PostCompact'});
  db.exec('ALTER TABLE requests DROP COLUMN external_id; ALTER TABLE requests DROP COLUMN timing_kind; ALTER TABLE sessions DROP COLUMN compact_triggers;');
  db.close();
  const migrated=openStore(dir);
  assert.equal(summarize(migrated,'legacy').compactions.known_total,1);
  assert(migrated.prepare('PRAGMA table_info(requests)').all().some(row=>row.name==='external_id'));
  migrated.close();
});

test('real Hook CLI I/O can replay a complete Grok compaction cycle without a model',()=>{
  const {db,dir}=store();db.close();
  const script=fileURLToPath(new URL('./guard.mjs',import.meta.url));
  for(const hookEventName of ['SessionStart','PreCompact','PostCompact']) {
    const r=spawnSync(process.execPath,['--no-warnings',script,'hook','--client','grok','--state-dir',dir],
      {input:JSON.stringify({sessionId:'same-id',hookEventName}),encoding:'utf8'});
    assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{});
  }
  const r=spawnSync(process.execPath,['--no-warnings',script,'report','--client','grok','--session','same-id','--state-dir',dir],{encoding:'utf8'});
  assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).compactions.known_total,1);
});

test('a generated hook command executes through the platform shell with a spaced state path',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ctg state space-'));
  const skillDir=fileURLToPath(new URL('..',import.meta.url));
  const shell=process.platform==='win32'?'powershell':'posix';
  const config=buildConfig({client:'grok',skillDir,stateDir:dir,node:process.execPath,shell});
  const command=config.hooks.SessionStart[0].hooks[0].command;
  const payload=JSON.stringify({sessionId:'shell-test',hookEventName:'SessionStart'});
  const result=process.platform==='win32'?
    spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{input:payload,encoding:'utf8'}):
    spawnSync('/bin/sh',['-c',command],{input:payload,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{});
  const db=openStore(dir);assert.equal(summarize(db,sessionKey('grok','shell-test')).status,'observed');db.close();
});
