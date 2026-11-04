import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseSettings, detectClients, commandOf, inspectClient, owned, stateOf } from './setup-config.mjs';
import { buildSetupPlan, publicPlan, applySetupPlan, rollbackSetup, runtimeFiles, SOURCE_ROOT } from './setup-engine.mjs';
import { parseDefaultRoute, startNetwork } from './setup-runtime.mjs';
import { createDashboard } from './dashboard.mjs';
import { loadPolicy, openStore, ingest } from './guard.mjs';
import { parseToml } from '../vendor/setup-codecs.mjs';

function fixture(t,clients=['codex']) {
  const home=mkdtempSync(join(tmpdir(),'ctg-setup-'));
  for(const client of clients)mkdirSync(join(home,'.'+client),{recursive:true});
  t.after(()=>{assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert(basename(home).startsWith('ctg-setup-'));rmSync(home,{recursive:true,force:true});});
  return {home,options:{home,env:{PATH:''},sourceRoot:SOURCE_ROOT}};
}
test('discovery uses documented config roots and command presence, without running clients or reading credentials',t=>{
  const {home}=fixture(t,[]),custom=join(home,'custom');mkdirSync(custom);
  const bin=join(home,'bin');mkdirSync(bin);writeFileSync(join(bin,process.platform==='win32'?'claude.cmd':'claude'),'do not execute');
  const result=detectClients({home,env:{CODEX_HOME:custom,CLAUDE_CONFIG_DIR:join(home,'claude-custom'),GEMINI_CLI_HOME:join(home,'gemini-home'),PATH:bin}});
  assert(result.find(c=>c.id==='codex').detected);assert(result.find(c=>c.id==='claude').detected);
  assert.equal(result.find(c=>c.id==='gemini').root,join(home,'gemini-home','.gemini'));
  assert(!result.find(c=>c.id==='grok').detected);
});
test('one setup installs complete resources, preserves JSONC and unrelated hooks, and is idempotent',async t=>{
  const {home,options}=fixture(t),path=join(home,'.codex','hooks.json');
  const original='\uFEFF{\n  // keep this comment\n  "custom": "SECRET_STAYS_LOCAL",\n  "hooks": {"Stop": [{"hooks":[{"type":"command","command":"existing-tool"}]}],},\n}\n';
  writeFileSync(path,original);
  const plan=buildSetupPlan(options);assert(plan.canApply);assert(!JSON.stringify(publicPlan(plan)).includes('SECRET_STAYS_LOCAL'));
  const result=await applySetupPlan(plan);assert(result.ok,result.code);
  const after=readFileSync(path,'utf8');assert(after.includes('// keep this comment'));assert(after.startsWith('\uFEFF'));
  const settings=parseSettings(Buffer.from(after));assert.equal(settings.custom,'SECRET_STAYS_LOCAL');
  assert.equal(settings.hooks.Stop[0].hooks[0].command,'existing-tool');assert.equal(settings.hooks.Stop.length,2);
  const second=buildSetupPlan(options);assert.equal(second.operations.length,0);
  const repeated=await applySetupPlan(second);assert(repeated.reused);assert.equal(repeated.receipt.id,result.receipt.id);
  assert(existsSync(join(home,'.codex','skills','context-traffic-guard','scripts','setup.mjs')));
  assert(existsSync(join(result.receipt.runtime_dir,'vendor','setup-codecs.mjs')));
  const db=openStore(plan.primaryState);assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);db.close();
  const restore=rollbackSetup(plan.appDir,result.receipt.id);assert(restore.ok);assert.equal(readFileSync(path,'utf8'),original);
  assert(existsSync(join(plan.primaryState,'metrics.sqlite')),'rollback must preserve telemetry');
});
test('existing owned hooks and historical state keep their exact commands and data directory',async t=>{
  const {home,options}=fixture(t),state=join(home,'legacy state'),db=openStore(state);
  ingest(db,{hook_event_name:'SessionStart',session_id:'preserved'});db.close();
  const command=process.execPath+' --no-warnings "'+join(home,'.codex/skills/context-traffic-guard/scripts/guard.mjs')+'" hook --state-dir "'+state+'" --sample-traffic --pipe "legacy-pipe"';
  const events=['SessionStart','PreCompact','PostCompact','PreModelRequest','PostModelRequest','UserPromptSubmit','PostToolUse','Stop'];
  const original=JSON.stringify({hooks:Object.fromEntries(events.map(e=>[e,[{hooks:[{type:'command',command,timeout:3}]}]]))});
  const path=join(home,'.codex/hooks.json');writeFileSync(path,original);
  const plan=buildSetupPlan(options);assert.equal(plan.primaryState,state);assert(plan.clients[0].proxy_sampling);
  assert(!plan.operations.some(o=>o.path===path));assert((await applySetupPlan(plan)).ok);
  assert.equal(readFileSync(path,'utf8'),original);
  const after=openStore(state);assert.equal(after.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);after.close();
});
test('inline Codex TOML hooks are extended in place, with no duplicate JSON hook source',async t=>{
  const {home,options}=fixture(t),path=join(home,'.codex/config.toml');
  const original='# preserve model preferences\nmodel = "test-model"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype="command"\ncommand="foreign-monitor"\n';
  writeFileSync(path,original);
  const plan=buildSetupPlan(options);assert(plan.operations.some(o=>o.path===path));
  assert(!plan.operations.some(o=>o.path===join(home,'.codex/hooks.json')));
  assert((await applySetupPlan(plan)).ok);
  const text=readFileSync(path,'utf8');assert(text.startsWith(original));const config=parseToml(text);
  assert.equal(config.hooks.Stop.length,2);assert.equal(config.model,'test-model');
  assert.equal(buildSetupPlan(options).operations.length,0);
});
test('Claude retains an existing status line and opaque user settings',async t=>{
  const {home,options}=fixture(t,['claude']),path=join(home,'.claude/settings.json');
  const statusLine={type:'command',command:'my-existing-status'};
  writeFileSync(path,JSON.stringify({statusLine,env:{EXAMPLE:'PRIVATE_VALUE'},permissions:{deny:['Read(secret)']}}));
  const plan=buildSetupPlan(options);assert((await applySetupPlan(plan)).ok);
  const after=parseSettings(readFileSync(path));assert.deepEqual(after.statusLine,statusLine);assert.equal(after.env.EXAMPLE,'PRIVATE_VALUE');
  assert.deepEqual(after.permissions,{deny:['Read(secret)']});assert(plan.clients[0].notes.some(n=>n.includes('保留原有状态栏')));
  assert(!JSON.stringify(publicPlan(plan)).includes('PRIVATE_VALUE'));
});
test('fresh Claude gets a state snapshot command, Gemini gets lightweight hooks and millisecond timeouts',async t=>{
  const {home,options}=fixture(t,['claude','gemini']);const plan=buildSetupPlan(options);assert((await applySetupPlan(plan)).ok);
  const claude=parseSettings(readFileSync(join(home,'.claude/settings.json'))),gemini=parseSettings(readFileSync(join(home,'.gemini/settings.json')));
  assert(owned(claude.statusLine));assert(!gemini.hooks.AfterModel);
  assert.equal(gemini.hooks.PreCompress[0].hooks[0].timeout,3000);
  assert.equal(gemini.hooks.PreCompress[0].hooks[0].name,'context-traffic-guard');
});
test('disabled hooks stay disabled and are not overridden by automatic setup',async t=>{
  const {home,options}=fixture(t,['claude','gemini']);
  writeFileSync(join(home,'.claude/settings.json'),'{"disableAllHooks":true}');
  writeFileSync(join(home,'.gemini/settings.json'),'{"hooksConfig":{"enabled":false}}');
  const plan=buildSetupPlan(options);assert(!plan.canApply);assert(plan.clients.every(c=>c.status==='blocked'));
  assert(!(await applySetupPlan(plan)).ok);assert(!existsSync(join(home,'.context-traffic-guard')));
});
test('invalid settings are left untouched and parser errors never expose private source text',t=>{
  const {home,options}=fixture(t),path=join(home,'.codex/config.toml'),original='api_key = "PRIVATE_INVALID\n';writeFileSync(path,original);
  const plan=buildSetupPlan(options);assert(!plan.canApply);assert(!JSON.stringify(publicPlan(plan)).includes('PRIVATE_INVALID'));
  assert.equal(readFileSync(path,'utf8'),original);
});
test('Grok discovers owned hooks in other hook files and does not register duplicates',async t=>{
  const {home,options}=fixture(t,['grok']);mkdirSync(join(home,'.grok/hooks'));
  const events=['SessionStart','PreCompact','PostCompact','UserPromptSubmit','PostToolUse','Stop','StopFailure'];
  const command=commandOf([process.execPath,join(home,'context-traffic-guard/scripts/guard.mjs'),'hook','--state-dir',join(home,'grok-state'),'--ctg-owner','context-traffic-guard-v1']);
  const other=join(home,'.grok/hooks/other-name.json');writeFileSync(other,JSON.stringify({hooks:Object.fromEntries(events.map(e=>[e,[{hooks:[{type:'command',command}]}]]))}));
  const plan=buildSetupPlan(options);assert(!plan.operations.some(o=>o.path.endsWith('context-traffic-guard.json')));
  assert((await applySetupPlan(plan)).ok);assert(!existsSync(join(home,'.grok/hooks/context-traffic-guard.json')));
});
test('independent existing state directories remain distinct in the source registry',t=>{
  const {home,options}=fixture(t,['codex','claude']);
  for(const client of ['codex','claude']) {
    const command=commandOf([process.execPath,join(home,'context-traffic-guard/scripts/guard.mjs'),'hook','--state-dir',join(home,client+'-state'),'--ctg-owner','context-traffic-guard-v1']);
    writeFileSync(join(home,'.'+client,client==='codex'?'hooks.json':'settings.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command}]}]}}));
  }
  const plan=buildSetupPlan(options);assert.equal(plan.states.length,2);assert.equal(publicPlan(plan).state_sources.length,2);
  assert.equal(new Set(publicPlan(plan).state_sources.map(s=>s.id)).size,2);
});
test('configuration races roll back applied changes and preserve concurrent edits',async t=>{
  const {home,options}=fixture(t),path=join(home,'.codex/hooks.json');writeFileSync(path,'{}');
  const plan=buildSetupPlan(options),result=await applySetupPlan(plan,{beforeWrite(op){if(op.path===path)writeFileSync(path,'{"changed_by_user":true}');}});
  assert(!result.ok);assert.equal(result.code,'configuration_changed');assert.equal(readFileSync(path,'utf8'),'{"changed_by_user":true}');
  assert(!existsSync(join(plan.runtimeDir,'scripts/guard.mjs')));
  assert(!existsSync(join(plan.appDir,'setup/apply.lock')));
});
test('rollback refuses subsequent edits before removing any runtime file',async t=>{
  const {home,options}=fixture(t),plan=buildSetupPlan(options),result=await applySetupPlan(plan);assert(result.ok);
  const path=join(home,'.codex/hooks.json');writeFileSync(path,readFileSync(path,'utf8')+'\n// new edit');
  const rollback=rollbackSetup(plan.appDir,result.receipt.id);assert(!rollback.ok);assert.equal(rollback.restored.length,0);
  assert(existsSync(join(plan.runtimeDir,'scripts/guard.mjs')));assert(readFileSync(path,'utf8').includes('// new edit'));
});
test('managed runtime edits and unrelated files in the distribution are preserved',async t=>{
  const {home,options}=fixture(t),plan=buildSetupPlan(options);assert((await applySetupPlan(plan)).ok);
  const guard=join(plan.runtimeDir,'scripts/guard.mjs');writeFileSync(guard,'// custom edit');
  const next=buildSetupPlan(options);assert(!next.canApply);assert.equal(next.runtimeError,'managed_file_modified');
  assert.equal(readFileSync(guard,'utf8'),'// custom edit');
  assert(!runtimeFiles(SOURCE_ROOT).some(f=>f.path.includes('node_modules')||f.path.endsWith('.env')));
});
test('shell commands round-trip UTF-8 stdin and hostile-looking literal paths without evaluation',t=>{
  const value='中文 $x ` & ! % literal';
  const script='process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify([s,process.argv[1]])))';
  const command=commandOf([process.execPath,'-e',script,value]);
  const result=process.platform==='win32'?spawnSync('cmd.exe',['/d','/s','/c',command],{input:'输入 JSON',encoding:'utf8',timeout:10000,windowsHide:true}):spawnSync('/bin/sh',['-c',command],{input:'输入 JSON',encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),['输入 JSON',value]);
  const hook={command:commandOf([process.execPath,'guard.mjs','hook','--state-dir',join(tmpdir(),'spaces and 中文'),'--ctg-owner','context-traffic-guard-v1'])};
  assert(owned(hook));assert.equal(stateOf(hook),resolve(tmpdir(),'spaces and 中文'));
});
test('default route selection keeps ambiguous exits unknown instead of summing adapters',()=>{
  assert.equal(parseDefaultRoute('linux','Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 00000001 0003 0 0 10 00000000\ntun0 00000000 00000001 0003 0 0 20 00000000'),'eth0');
  assert.equal(parseDefaultRoute('linux','Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 00000001 0003 0 0 10 00000000\ntun0 00000000 00000001 0003 0 0 10 00000000'),null);
  assert.equal(parseDefaultRoute('darwin',' gateway: 192.0.2.1\n interface: en0\n'),'en0');
  assert.equal(parseDefaultRoute('win32','[{"Name":"WLAN","Metric":10},{"Name":"VPN","Metric":20}]'),'WLAN');
});
test('network auto sampling is bounded and can be stopped without leaving another write',async()=>{
  let writes=0;const listener=[];
  const runner=startNetwork({states:['state'],maxSeconds:20,route:async()=> 'eth0',read:async()=>[{name:'eth0',uploadTotal:100,downloadTotal:200}],open:()=>({close(){}}),store(){writes++;},onChange:s=>listener.push(s.status),platform:'linux'});
  while(!writes)await new Promise(resolve=>setTimeout(resolve,2));
  runner.stop();await runner.task;assert.equal(writes,1);assert.equal(runner.status.status,'stopped');assert(listener.includes('sampling'));
  let reads=0;const proxy=startNetwork({states:['state'],proxy:true,read:async()=>{reads++;return [];}});await proxy.task;assert.equal(reads,0);proxy.stop();
});
test('setup HTTP writes require same-origin token and immutable plan identity',async t=>{
  const {home}=fixture(t,[]);let called=0;
  const controller={token:'test-token',instanceId:'test-instance',status:()=>({token:'test-token'}),scan:()=>({}),apply:async id=>{called++;return {ok:id==='correct'};}};
  const server=createDashboard({stateDir:home,policy:loadPolicy(),setupController:controller});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port+'/api/setup/apply',body=JSON.stringify({plan_id:'correct'});
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body})).status,403);assert.equal(called,0);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-ctg-setup-token':'test-token',Origin:'https://elsewhere.example'},body})).status,403);assert.equal(called,0);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-ctg-setup-token':'test-token'},body})).status,200);assert.equal(called,1);
});
test('state source IDs prevent a same session ID from leaking metrics between databases',async t=>{
  const {home}=fixture(t,[]),a=join(home,'a'),b=join(home,'b');
  for(const [dir,value] of [[a,100],[b,900]]){const db=openStore(dir);ingest(db,{session_id:'same',hook_event_name:'PostModelRequest',status:'completed',token_usage:{input_tokens:value,output_tokens:100}});db.close();}
  const server=createDashboard({stateDir:a,stateSources:[{path:b}],policy:loadPolicy()});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port;
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());assert.equal(boot.state_sources.length,2);
  const values=[];
  for(const source of boot.state_sources){const row=await fetch(url+'/api/bootstrap?source='+source.id).then(r=>r.json());const result=await fetch(url+'/api/session?key='+row.sessions[0].key+'&source='+source.id).then(r=>r.json());values.push(result.report.tokens.latest_input);}
  assert.deepEqual(values,[100,900]);assert.equal((await fetch(url+'/api/bootstrap?source=unknown')).status,400);
});
test('a failed write can be retried and installs the client Skill after empty-directory recovery',async t=>{
  const {home,options}=fixture(t),plan=buildSetupPlan(options);
  const first=await applySetupPlan(plan,{beforeWrite(op){if(op.kind==='hooks')throw new Error('injected_write_failure');}});
  assert(!first.ok);assert.equal(first.recovery.skipped.length,0);
  const second=await applySetupPlan(buildSetupPlan(options));assert(second.ok,second.code);
  assert(existsSync(join(home,'.codex/skills/context-traffic-guard/SKILL.md')));
});
test('panel follows the configured primary directory after setup rather than retaining an empty startup directory',async t=>{
  const {home}=fixture(t,[]),empty=join(home,'empty'),a=join(home,'a'),b=join(home,'b');
  for(const dir of [a,b]){const db=openStore(dir);db.close();}
  let ready=false;
  const server=createDashboard({stateDir:()=>ready?a:empty,stateSources:()=>[{path:a},{path:b}],policy:loadPolicy()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/api/bootstrap').then(r=>r.json())).state_path,empty);
  ready=true;
  const after=await fetch(url+'/api/bootstrap').then(r=>r.json());assert.equal(after.state_path,a);assert.equal(after.state_sources.length,2);assert(after.ok);
});
test('a newly generated Hook executes end-to-end with quoted Unicode paths and creates only the supplied test event',async t=>{
  const base=fixture(t,[]).home,home=join(base,"User O'Connor $`!%");mkdirSync(join(home,'.codex'),{recursive:true});
  const options={home,env:{PATH:''},sourceRoot:SOURCE_ROOT},plan=buildSetupPlan(options);assert((await applySetupPlan(plan)).ok);
  const hooks=parseSettings(readFileSync(join(home,'.codex/hooks.json'))).hooks,hook=hooks.SessionStart[0].hooks[0];
  assert.equal(stateOf(hook),plan.primaryState);
  const input=JSON.stringify({session_id:'中文会话 $x',hook_event_name:'SessionStart'});
  const result=process.platform==='win32'?spawnSync('cmd.exe',['/d','/s','/c',hook.command],{input,encoding:'utf8',timeout:10000,windowsHide:true}):spawnSync('/bin/sh',['-c',hook.command],{input,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{});
  const db=openStore(plan.primaryState);assert.equal(db.prepare('SELECT session FROM sessions').get().session,'中文会话 $x');db.close();
  assert.equal(buildSetupPlan(options).operations.length,0);
});
test('native one-click launcher hands off to the bundled installer without applying a dry run',t=>{
  const {home}=fixture(t),env={...process.env,CTG_NODE:process.execPath};
  let result;
  if(process.platform==='win32') {
    const cmd='""'+join(SOURCE_ROOT,'Start-Context-Guard.cmd')+'" --home "'+home+'" --plan"';
    result=spawnSync('cmd.exe',['/d','/s','/c',cmd],{env,encoding:'utf8',timeout:15000,windowsVerbatimArguments:true,windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert(JSON.parse(result.stdout).can_apply);
  } else result=spawnSync('/bin/bash',[join(SOURCE_ROOT,process.platform==='darwin'?'Start-Context-Guard.command':'start-context-guard.sh'),'--home',home,'--plan'],{env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert(JSON.parse(result.stdout).can_apply);
  assert(!existsSync(join(home,'.codex/hooks.json')));
});
test('installed setup launches a real panel, reuses it on a second run, and exposes waiting-for-events accurately',async t=>{
  const {home}=fixture(t),port=55000+Math.floor(Math.random()*8000),entry=join(SOURCE_ROOT,'scripts/setup.mjs');
  let info;
  t.after(async()=>{if(info){try {process.kill(info.pid,'SIGTERM');}catch{} for(let i=0;i<20;i++){try{await fetch(info.url+'/api/health',{signal:AbortSignal.timeout(100)});await new Promise(r=>setTimeout(r,50));}catch{break;}}}});
  const args=['--no-warnings',entry,'--home',home,'--port',String(port),'--no-open','--no-traffic'];
  const first=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(first.status,0,first.stderr);const result=JSON.parse(first.stdout);assert(result.ok);info=result.panel;
  assert.equal(info.browser,'not_requested');assert(!info.reused);
  const boot=await fetch(info.url+'/api/bootstrap').then(r=>r.json());assert.equal(boot.sessions.length,0);assert(boot.setup.receipt);assert.deepEqual(boot.setup.observations,{});
  assert((await fetch(info.url).then(r=>r.text())).includes('Context Guard'));
  const second=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000,windowsHide:true});assert.equal(second.status,0,second.stderr);
  const repeated=JSON.parse(second.stdout);assert(repeated.reused);assert(repeated.panel.reused);assert.equal(repeated.panel.pid,info.pid);
});
