import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboard } from './dashboard.mjs';
import { createSetupController } from './setup-runtime.mjs';
import { latestReceipt } from './setup-engine.mjs';
import { loadPolicy } from './guard.mjs';

export async function serveSetup(options) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),controller=createSetupController(options);
  const receipt=latestReceipt(join(options.home,'.context-traffic-guard'));
  const stateDir=controller.primaryState;
  const assetsDir=()=>existsSync(join(root,'dashboard','dist','index.html'))?join(root,'dashboard','dist'):
    join(receipt?.original_source_root??root,'dashboard','dist');
  let server;
  for(let attempt=0;attempt<10;attempt++) {
    server=createDashboard({stateDir,policy:loadPolicy(join(root,'integration','policy.json')),initial:options.initial,
      handoffPath:options.handoffPath,stateSources:controller.sources,setupController:controller,assetsDir});
    try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen((options.port??43871)+attempt,'127.0.0.1',resolve);});break;}
    catch(error) {if(error.code!=='EADDRINUSE'||attempt===9)throw error;}
  }
  controller.start();
  const control=join(options.home,'.context-traffic-guard','setup');mkdirSync(control,{recursive:true,mode:0o700});
  const info={app:'context-traffic-guard',protocol:2,pid:process.pid,instance_id:controller.instanceId,url:'http://127.0.0.1:'+server.address().port,started_at:Date.now()};
  const path=join(control,'server.json'),tmp=path+'.'+process.pid+'.tmp';
  writeFileSync(tmp,JSON.stringify(info,null,2),{mode:0o600});renameSync(tmp,path);
  const stop=()=>{controller.stop();server.closeAllConnections();server.close();};
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
  process.once('exit',()=>controller.stop());
  return {server,controller,info,stop};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options=JSON.parse(readFileSync(process.argv[2],'utf8'));
  serveSetup(options).catch(()=>{process.stderr.write('Context Guard: setup panel could not start.\n');process.exitCode=1;});
}
