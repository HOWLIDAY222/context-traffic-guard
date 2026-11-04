import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function infoFrom(path) {
  try {
    const info=JSON.parse(readFileSync(path,'utf8')),url=new URL(info.url);
    if(info.app!=='context-traffic-guard'||info.protocol!==2||url.hostname!=='127.0.0.1'||url.protocol!=='http:')return null;
    const health=await fetch(info.url+'/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
    return health.app===info.app&&health.instance_id===info.instance_id?info:null;
  } catch {return null;}
}
export async function launchSetupPanel(options,{open=true}={}) {
  const {openPanel}=await import('./setup-runtime.mjs');
  const {latestReceipt}=await import('./setup-engine.mjs');
  const control=join(options.home,'.context-traffic-guard','setup');mkdirSync(control,{recursive:true,mode:0o700});
  const running=await infoFrom(join(control,'server.json'));
  if(running) {
    const state=await fetch(running.url+'/api/setup',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
    if(state.token)await fetch(running.url+'/api/setup/reload',{method:'POST',headers:{'content-type':'application/json','x-ctg-setup-token':state.token},body:'{}',signal:AbortSignal.timeout(3000)});
    let browser='not_requested';if(open){try {await openPanel(running.url+'/?setup=1');browser='requested';}catch{browser='unavailable';}}
    return {...running,reused:true,browser};
  }
  const receipt=latestReceipt(join(options.home,'.context-traffic-guard'));
  const root=receipt?.runtime_dir??ROOT;
  const launch=join(control,'launch.json');
  writeFileSync(launch,JSON.stringify({...options,sourceRoot:root},null,2),{mode:0o600});
  const log=openSync(join(control,'server.log'),'a',0o600);
  const child=spawn(process.execPath,['--no-warnings',join(root,'scripts','setup-server.mjs'),launch],{detached:true,stdio:['ignore',log,log],windowsHide:true});
  let spawnError=null;child.once('error',error=>{spawnError=error;});
  child.unref();closeSync(log);
  for(let attempt=0;attempt<80;attempt++) {
    if(spawnError)throw new Error('panel_process_spawn_failed');
    const info=await infoFrom(join(control,'server.json'));
    if(info) {
      let browser='not_requested';if(open){try {await openPanel(info.url+'/?setup=1');browser='requested';}catch{browser='unavailable';}}
      return {...info,reused:false,browser};
    }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error('panel_start_timeout');
}
async function main() {
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('node_24_required_use_launcher');
  const args={},flags=new Set(['--plan','--no-panel','--no-open','--no-traffic','--gemini-detailed']);
  for(let i=2;i<process.argv.length;i++) {
    const key=process.argv[i];
    if(flags.has(key))args[key.slice(2)]=true;
    else if(['--home','--state-dir','--clients','--port','--rollback','--client','--session','--source','--agent','--handoff','--interface'].includes(key)&&process.argv[i+1])args[key.slice(2)]=process.argv[++i];
    else throw new Error('invalid_setup_argument');
  }
  const {CLIENT_IDS}=await import('./setup-config.mjs');
  if(args.clients&&args.clients.split(',').some(c=>!CLIENT_IDS.includes(c)))throw new Error('invalid_clients');
  const home=resolve(args.home??homedir());
  const {buildSetupPlan,publicPlan,applySetupPlan,rollbackSetup}=await import('./setup-engine.mjs');
  if(args.rollback){process.stdout.write(JSON.stringify(rollbackSetup(join(home,'.context-traffic-guard'),args.rollback),null,2)+'\n');return;}
  const initial=args.session?{client:args.client,session:args.session,source:args.source,agent:args.agent}:!args.home&&process.env.CODEX_THREAD_ID?{client:'codex',session:process.env.CODEX_THREAD_ID}:{};
  if(initial.session&&!CLIENT_IDS.includes(initial.client))throw new Error('explicit_client_required');
  const options={home,sourceRoot:ROOT,initial,clients:args.clients?.split(','),stateDir:args['state-dir']?resolve(args['state-dir']):undefined,
    traffic:!args['no-traffic'],detailed:!!args['gemini-detailed'],interfaceName:args.interface,
    handoffPath:args.handoff?resolve(args.handoff):undefined,port:Number(args.port??43871),...(args.home?{env:{PATH:''}}:{})};
  if(!Number.isInteger(options.port)||options.port<1024||options.port>65526)throw new Error('invalid_port');
  const plan=buildSetupPlan(options);
  if(args.plan){process.stdout.write(JSON.stringify(publicPlan(plan),null,2)+'\n');return;}
  const result=await applySetupPlan(plan);
  const panel=args['no-panel']?null:await launchSetupPanel(options,{open:!args['no-open']});
  process.stdout.write(JSON.stringify({ok:result.ok,code:result.code??null,reused:result.reused??false,
    clients:(result.receipt?.clients??plan.clients).map(c=>({id:c.id,status:c.status,state_dir:c.state_dir,notes:c.notes,reason:c.reason})),
    backup_dir:result.receipt?.backup_dir??result.backup_dir??null,changed_files:result.receipt?.changed_files??0,
    panel,trust:'请完成客户端自身要求的 Hook 审核；面板收到真实事件后才显示已接通。'},null,2)+'\n');
  if(!result.ok)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write('Context Guard: '+error.message+'.\n');process.exitCode=1;});
