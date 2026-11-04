import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readSystemInterfaces, selectInterface } from './system-traffic.mjs';
import { openStore, storeSystemSnapshot } from './guard.mjs';
import { buildSetupPlan, publicPlan, applySetupPlan, latestReceipt, rollbackSetup } from './setup-engine.mjs';

const execute=promisify(execFile);
export function parseDefaultRoute(platform,text) {
  if(platform==='linux') {
    const routes=text.trim().split(/\r?\n/).slice(1).map(l=>l.trim().split(/\s+/)).filter(v=>v.length>=8&&v[1]==='00000000'&&(parseInt(v[3],16)&1));
    routes.sort((a,b)=>Number(a[6])-Number(b[6]));
    if(!routes.length) return null;
    const best=routes.filter(r=>Number(r[6])===Number(routes[0][6]));
    return new Set(best.map(r=>r[0])).size===1?best[0][0]:null;
  }
  if(platform==='darwin') return /^\s*interface:\s*(\S+)\s*$/m.exec(text)?.[1]??null;
  const rows=JSON.parse(text.replace(/^\uFEFF/,''));
  const values=Array.isArray(rows)?rows:[rows];
  if(!values.length) return null;
  values.sort((a,b)=>a.Metric-b.Metric);
  return new Set(values.filter(r=>r.Metric===values[0].Metric).map(r=>r.Name)).size===1?values[0].Name:null;
}
export async function defaultInterface({platform=process.platform,signal}={}) {
  if(platform==='linux') return parseDefaultRoute(platform,await readFile('/proc/net/route',{encoding:'utf8',signal}));
  if(platform==='darwin') {
    const {stdout}=await execute('/sbin/route',['-n','get','default'],{encoding:'utf8',timeout:10000,signal});
    return parseDefaultRoute(platform,stdout);
  }
  if(platform==='win32') {
    const script='[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '+
      '$interfaces = Get-NetIPInterface -AddressFamily IPv4 -ErrorAction Stop; '+
      '@(Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop | ForEach-Object { '+
      '$route = $_; $iface = $interfaces | Where-Object InterfaceIndex -eq $route.InterfaceIndex | Select-Object -First 1; '+
      'if ($iface.ConnectionState -eq "Connected") { [pscustomobject]@{Name=$route.InterfaceAlias; Metric=([int]$route.RouteMetric + [int]$iface.InterfaceMetric)} } }) | ConvertTo-Json -Compress';
    const {stdout}=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:30000,windowsHide:true,signal});
    return parseDefaultRoute(platform,stdout);
  }
  return null;
}
export function startNetwork({states,proxy=false,interfaceName,enabled=true,maxSeconds=86400,
  route=defaultInterface,read=readSystemInterfaces,store=storeSystemSnapshot,open=openStore,platform=process.platform,onChange=()=>{}}) {
  const abort=new AbortController();let timer;
  const status={status:proxy?'existing_proxy':!enabled?'disabled':states.length?'detecting':'not_configured',interface:null,samples:0,failures:0,expires_at:null};
  const set=patch=>{Object.assign(status,patch);onChange({...status});};
  const wait=ms=>new Promise(resolve=>{const done=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',done);resolve();};timer=setTimeout(done,ms);abort.signal.addEventListener('abort',done,{once:true});});
  const task=(async()=>{
    if(!enabled||proxy||!states.length) return;
    try {
      const name=interfaceName??await route({platform,signal:abort.signal});
      if(abort.signal.aborted)return;
      if(!name) {set({status:'needs_interface',reason:'没有唯一可确认的默认出口；可在向导中选择一张网卡。'});return;}
      set({interface:name,expires_at:Date.now()+maxSeconds*1000});
      let failures=0;
      while(!abort.signal.aborted&&Date.now()<status.expires_at) {
        try {
          const snapshot=selectInterface(await read({platform,signal:abort.signal}),name,platform);
          if(abort.signal.aborted) break;
          for(const state of states) {const db=open(state);try {store(db,snapshot);} finally {db.close();}}
          failures=0;set({status:'sampling',samples:status.samples+1,last_sample:Date.now()});
        } catch {if(abort.signal.aborted)break;failures++;set({status:failures>=3?'unavailable':'retrying',failures:status.failures+1});if(failures>=3)break;}
        await wait(5000);
      }
      if(!abort.signal.aborted&&status.status==='sampling') set({status:'finished'});
    } catch {if(!abort.signal.aborted)set({status:'unavailable',reason:'系统没有提供可读取的默认网卡计数。'});}
  })();
  return {status,task,stop(){abort.abort();clearTimeout(timer);set({status:'stopped'});}};
}
export function createSetupController(options={}) {
  const initialPlan=buildSetupPlan(options),token=randomBytes(24).toString('hex'),instanceId=randomBytes(16).toString('hex');
  let plan=initialPlan,receipt=latestReceipt(plan.appDir),network=null,busy=false,trafficEnabled=options.traffic!==false,chosenInterface=options.interfaceName;
  const sources=()=>receipt?.state_sources??publicPlan(plan).state_sources;
  function observations() {
    const result={};
    for(const source of sources()) {
      let db;try {db=new DatabaseSync(join(source.path,'metrics.sqlite'),{readOnly:true});
        for(const row of db.prepare('SELECT c.client,MAX(s.activity) activity FROM clients c JOIN sessions s USING(session,agent) GROUP BY c.client').all())result[row.client]=Math.max(result[row.client]??0,row.activity);
      } catch {} finally {db?.close();}
    }
    return result;
  }
  function restartNetwork({enabled=trafficEnabled,interfaceName=chosenInterface}={}) {
    network?.stop();
    const states=receipt?.states??[];
    network=startNetwork({states,enabled,interfaceName,proxy:receipt?.clients?.some(c=>c.proxy_sampling)??false});
  }
  const controller={token,instanceId,sources,primaryState:()=>receipt?.primary_state??plan.primaryState,
    status(){return {plan:publicPlan(plan),receipt:receipt?{id:receipt.id,created_at:receipt.created_at,backup_dir:receipt.backup_dir,changed_files:receipt.changed_files,status:receipt.status??'applied',clients:receipt.clients}:null,
      network:network?.status??{status:'not_configured'},observations:observations(),busy,token,instance_id:instanceId};},
    scan(){if(!busy)plan=buildSetupPlan(options);return this.status();},
    reload(){receipt=latestReceipt(plan.appDir);plan=buildSetupPlan(options);restartNetwork();return {ok:true,status:this.status()};},
    async apply(id) {
      if(busy)return {ok:false,code:'setup_in_progress'};
      const fresh=buildSetupPlan(options);
      if(id!==fresh.id) {plan=fresh;return {ok:false,code:'configuration_changed',message:'配置在检测后发生变化，请重新检测后接入。'};}
      busy=true;
      try {
        const result=await applySetupPlan(fresh);
        if(result.ok) {receipt=result.receipt;plan=buildSetupPlan(options);restartNetwork();}
        busy=false;return {ok:result.ok,code:result.code??null,recovery:result.recovery??null,status:this.status()};
      } finally {busy=false;}
    },
    async networkAction({enabled,interfaceName}) {
      if(typeof enabled!=='boolean'||(interfaceName!==undefined&&(typeof interfaceName!=='string'||interfaceName.length>256))) return {ok:false,code:'invalid_network_option'};
      if(interfaceName!==undefined)selectInterface(await readSystemInterfaces(),interfaceName);
      trafficEnabled=enabled;chosenInterface=interfaceName;
      restartNetwork({enabled,interfaceName});return {ok:true,status:this.status()};
    },
    async interfaces(){return (await readSystemInterfaces()).map(i=>({name:i.name}));},
    rollback(id){network?.stop();const result=rollbackSetup(plan.appDir,id);receipt=latestReceipt(plan.appDir);if(result.ok&&receipt.original_source_root&&existsSync(join(receipt.original_source_root,'SKILL.md')))options.sourceRoot=receipt.original_source_root;plan=buildSetupPlan(options);return {...result,status:this.status()};},
    stop(){network?.stop();},
    start(){if(receipt&&receipt.status!=='rolled_back')restartNetwork();},
  };
  return controller;
}
export async function openPanel(url,{platform=process.platform}={}) {
  const parsed=new URL(url);
  if(parsed.hostname!=='127.0.0.1'||parsed.protocol!=='http:')throw new Error('local_panel_required');
  const program=platform==='win32'?'rundll32.exe':platform==='darwin'?'open':'xdg-open';
  const args=platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  await new Promise((resolve,reject)=>{
    const child=spawn(program,args,{detached:true,stdio:'ignore',windowsHide:true});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
}
