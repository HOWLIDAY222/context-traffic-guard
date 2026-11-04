import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, readOptional, detectClients, inspectClient, mergeClient, safeCode } from './setup-config.mjs';

export const SOURCE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>bytes===null?null:hash(bytes);
function bytesAt(path) {return existsSync(path)?readOptional(path):null;}
const containsFile=path=>readdirSync(path).some(name=>{const child=join(path,name),stat=lstatSync(child);return !stat.isDirectory()||stat.isSymbolicLink()||containsFile(child);});
export function runtimeFiles(root) {
  const paths=['SKILL.md','README.md','agents/openai.yaml','integration/policy.json','integration/hooks.preview.json',
    'package.json','pnpm-lock.yaml','dashboard/index.html','dashboard/vite.config.mjs','tooling/codecs.mjs','tooling/codecs.vite.mjs',
    'dashboard/src/main.jsx','dashboard/src/style.css','dashboard/src/format.mjs','dashboard/src/SetupPanel.jsx','dashboard/public/third-party-notices.txt','dashboard/dist/index.html','dashboard/dist/third-party-notices.txt',
    'vendor/setup-codecs.mjs','vendor/THIRD_PARTY_NOTICES.txt','Start-Context-Guard.cmd','Start-Context-Guard.command','start-context-guard.sh'];
  for(const name of ['adapters','adapters.test','audit-rollout','configure','guard','guard.test','traffic','system-traffic','system-traffic.test','dashboard','dashboard-data','dashboard.test','setup','setup-config','setup-engine','setup-runtime','setup-server','setup.test'])paths.push('scripts/'+name+'.mjs');
  for(const name of ['clients','events','dashboard','monitoring','measurement','setup'])paths.push('references/'+name+'.md');
  const assets=join(root,'dashboard','dist','assets');
  const html=join(root,'dashboard','dist','index.html');
  if(existsSync(assets)&&existsSync(html))for(const match of readFileSync(html,'utf8').matchAll(/(?:src|href)="\.\/assets\/(index-[A-Za-z0-9_-]+\.(?:js|css))"/g))paths.push('dashboard/dist/assets/'+match[1]);
  for(const path of paths)if(existsSync(join(root,path))&&lstatSync(join(root,path)).isSymbolicLink())throw new Error('runtime_symlink');
  return paths.filter(path=>existsSync(join(root,path))).map(path=>({path,bytes:readFileSync(join(root,path))}));
}
function copyPlan(files,target,managed=false) {
  const marker=join(target,'.ctg-install.json'),beforeMarker=bytesAt(marker);
  let prior=null;
  if(beforeMarker) {try {prior=JSON.parse(beforeMarker);} catch {throw new Error('invalid_install_marker');}}
  if(managed&&existsSync(target)&&!prior&&containsFile(target)) throw new Error('existing_managed_directory');
  const sourceVersion=JSON.parse(files.find(f=>f.path==='package.json')?.bytes??'{}').version??'0.0.0';
  const versionNumber=v=>v.split('.').slice(0,3).reduce((n,x)=>n*10000+(Number(x)||0),0);
  if(prior?.release&&versionNumber(sourceVersion)<versionNumber(prior.release))throw new Error('source_older_than_installed');
  const ops=[];
  for(const file of files) {
    const path=join(target,file.path),before=bytesAt(path),after=file.bytes;
    if(digest(before)===hash(after)) continue;
    if(managed&&before&&prior?.files?.[file.path]!==hash(before)) throw new Error('managed_file_modified');
    ops.push({path,before,after,kind:'runtime'});
  }
  const afterMarker=Buffer.from(JSON.stringify({version:1,name:'context-traffic-guard',release:sourceVersion,files:Object.fromEntries(files.map(f=>[f.path,hash(f.bytes)]))},null,2)+'\n');
  if(digest(beforeMarker)!==hash(afterMarker)) ops.push({path:marker,before:beforeMarker,after:afterMarker,kind:'runtime'});
  return ops;
}
export function buildSetupPlan(options={}) {
  const home=resolve(options.home??homedir()),platform=options.platform??process.platform,env=options.env??process.env;
  const appDir=join(home,'.context-traffic-guard'),sourceRoot=resolve(options.sourceRoot??SOURCE_ROOT),runtimeDir=join(appDir,'skill');
  const detected=detectClients({home,platform,env}),selected=detected.filter(c=>c.detected&&(!options.clients||options.clients.includes(c.id)));
  const inspected=selected.map(inspectClient),preferred=inspected.find(c=>c.id===options.initial?.client&&c.existingState)??inspected.find(c=>c.existingState);
  const primaryState=resolve(options.stateDir??preferred?.existingState??appDir),operations=[],clients=[];
  let runtimeError=null;
  try {
    const files=runtimeFiles(sourceRoot);
    if(!files.some(f=>f.path==='scripts/guard.mjs')||!files.some(f=>f.path==='dashboard/dist/index.html')) throw new Error('incomplete_skill');
    if(selected.length&&sourceRoot!==runtimeDir) operations.push(...copyPlan(files,runtimeDir,true));
    for(const client of inspected) {
      const stateDir=client.existingState??primaryState;
      let result;
      try {result=mergeClient(client,{stateDir,skillDir:runtimeDir,node:options.node??process.execPath,platform,detailed:options.detailed??false});}
      catch(error) {result={operations:[],status:'blocked',reason:safeCode(error),events:[],notes:[]};}
      const skillDir=join(client.root,'skills','context-traffic-guard');
      if(result.status!=='blocked') {
        if(!existsSync(skillDir)||lstatSync(skillDir).isDirectory()&&!lstatSync(skillDir).isSymbolicLink()&&!containsFile(skillDir)) operations.push(...copyPlan(files,skillDir));
        else if(existsSync(join(skillDir,'.ctg-install.json'))) {
          try {operations.push(...copyPlan(files,skillDir,true));result.notes.push('维护由向导安装的 Skill');}
          catch {result.notes.push('Skill 目录有本地修改，保留原目录；监测使用独立程序');}
        } else result.notes.push('沿用已有 Skill 目录');
        operations.push(...result.operations);
      }
      clients.push({id:client.id,root:client.root,config_path:client.path,reasons:client.reasons,state_dir:stateDir,
        proxy_sampling:client.proxySampling??false,status:result.status,reason:result.reason??null,events:result.events,notes:result.notes});
    }
  } catch(error) {runtimeError=error.message;operations.length=0;}
  const unique=new Map();
  for(const op of operations) {
    if(unique.has(op.path)&&hash(unique.get(op.path).after)!==hash(op.after)) throw new Error('conflicting_targets');
    unique.set(op.path,op);
  }
  const ops=[...unique.values()].filter(op=>digest(op.before)!==hash(op.after));
  const states=[...new Set(clients.filter(c=>c.status!=='blocked').map(c=>c.state_dir))];
  const id=hash(JSON.stringify({platform,clients:clients.map(c=>[c.id,c.state_dir,c.status,c.reason]),ops:ops.map(o=>[o.path,digest(o.before),hash(o.after)])}));
  return {version:1,id,home,platform,node:options.node??process.execPath,appDir,sourceRoot,runtimeDir,primaryState,
    detected:detected.map(c=>({id:c.id,detected:c.detected,reasons:c.reasons})),clients,states,operations:ops,runtimeError,
    canApply:!runtimeError&&clients.some(c=>c.status!=='blocked'),initial:options.initial??{},options};
}
export function publicPlan(plan) {
  return {version:1,id:plan.id,platform:plan.platform,node_version:process.versions.node,can_apply:plan.canApply,
    runtime_error:plan.runtimeError,detected:plan.detected,clients:plan.clients,
    state_sources:plan.states.map(path=>({id:hash(path).slice(0,16),label:path,path})),
    primary_state_id:hash(plan.primaryState).slice(0,16),changes:plan.operations.map(op=>({path:op.path,kind:op.kind,client:op.client??null,action:op.before===null?'create':'merge'})),
    trust_note:'配置已写入与事件已收到分别显示。Codex 仍需在 /hooks 或设置中审核；其他客户端可能需要重新启动会话。'};
}
function atomicFile(path,bytes,mode=0o600) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const tmp=path+'.ctg-'+randomBytes(6).toString('hex')+'.tmp';
  try {writeFileSync(tmp,bytes,{flag:'wx',mode});renameSync(tmp,path);if(process.platform!=='win32')chmodSync(path,mode);}
  finally {if(existsSync(tmp))unlinkSync(tmp);}
}
function restoreEntries(entries,folder) {
  const changed=entries.filter(entry=>digest(bytesAt(entry.path))!==entry.after_hash).map(entry=>entry.path);
  const damaged=entries.filter(entry=>entry.before_hash!==null&&(!existsSync(join(folder,entry.backup))||hash(readFileSync(join(folder,entry.backup)))!==entry.before_hash)).map(entry=>entry.path);
  if(changed.length||damaged.length)return {restored:[],skipped:[...new Set([...changed,...damaged])]};
  const restored=[],skipped=[];
  for(const entry of [...entries].reverse()) {
    const current=bytesAt(entry.path);
    if(digest(current)!==entry.after_hash) {skipped.push(entry.path);continue;}
    if(entry.before_hash===null) {if(current!==null)unlinkSync(entry.path);}
    else {
      const backup=join(folder,entry.backup),bytes=readFileSync(backup);
      if(hash(bytes)!==entry.before_hash) {skipped.push(entry.path);continue;}
      atomicFile(entry.path,bytes,entry.mode);
    }
    restored.push(entry.path);
  }
  return {restored,skipped};
}
export async function applySetupPlan(plan,{probe=true,beforeWrite}={}) {
  if(!plan.canApply) return {ok:false,code:plan.runtimeError??'no_eligible_client',plan:publicPlan(plan)};
  const previous=latestReceipt(plan.appDir);
  if(!plan.operations.length&&previous&&previous.status!=='rolled_back'&&
    JSON.stringify(previous.states)===JSON.stringify(plan.states)&&plan.states.every(path=>existsSync(join(path,'metrics.sqlite'))))
    return {ok:true,receipt:previous,plan:publicPlan(plan),reused:true};
  mkdirSync(plan.appDir,{recursive:true,mode:0o700});
  const control=join(plan.appDir,'setup');mkdirSync(control,{recursive:true,mode:0o700});
  const lock=join(control,'apply.lock');
  try {writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}
  catch {return {ok:false,code:'setup_in_progress'};}
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex'),folder=join(plan.appDir,'backups',id),entries=[];
  const journal={version:1,id,created_at:Date.now(),plan_id:plan.id,entries,db_backups:[]};
  mkdirSync(folder,{recursive:true,mode:0o700});
  let runtimeChecked=false;
  try {
    for(const op of plan.operations) {
      if(digest(bytesAt(op.path))!==digest(op.before)) throw new Error('configuration_changed');
      if(probe&&!runtimeChecked&&op.kind!=='runtime') {
        const result=spawnSync(plan.node,['--no-warnings',join(plan.runtimeDir,'scripts','guard.mjs'),'clients'],{encoding:'utf8',timeout:5000,windowsHide:true});
        if(result.status!==0) throw new Error('runtime_probe_failed');
        runtimeChecked=true;
      }
      const mode=op.before===null?0o600:lstatSync(op.path).mode&0o777;
      const entry={path:op.path,before_hash:digest(op.before),after_hash:hash(op.after),mode,backup:null,kind:op.kind};
      if(op.before!==null) {entry.backup=String(entries.length)+'.bak';writeFileSync(join(folder,entry.backup),op.before,{flag:'wx',mode:0o600});}
      beforeWrite?.(op);
      if(digest(bytesAt(op.path))!==digest(op.before)) throw new Error('configuration_changed');
      atomicFile(op.path,op.after,op.kind==='runtime'&&/\.(sh|command)$/.test(op.path)?0o700:mode);
      entries.push(entry);
      atomicFile(join(folder,'manifest.json'),Buffer.from(JSON.stringify(journal,null,2)+'\n'));
    }
    const {openStore}=await import('./guard.mjs');
    const {DatabaseSync,backup}=await import('node:sqlite');
    for(const state of plan.states) {
      const database=join(state,'metrics.sqlite');
      if(existsSync(database)&&plan.operations.length) {
        const read=new DatabaseSync(database,{readOnly:true}),file='metrics-'+journal.db_backups.length+'.sqlite';
        try {await backup(read,join(folder,file));journal.db_backups.push({state_dir:state,backup:file});} finally {read.close();}
      }
      const db=openStore(state);db.close();
    }
    journal.status='applied';atomicFile(join(folder,'manifest.json'),Buffer.from(JSON.stringify(journal,null,2)+'\n'));
    const receipt={version:1,id,created_at:journal.created_at,manifest_hash:hash(readFileSync(join(folder,'manifest.json'))),
      backup_dir:folder,changed_files:entries.length,clients:plan.clients,states:plan.states,primary_state:plan.primaryState,runtime_dir:plan.runtimeDir,
      state_sources:plan.states.map(path=>({id:hash(path).slice(0,16),label:path,path})),initial:plan.initial,
      original_source_root:plan.sourceRoot===plan.runtimeDir?(previous?.original_source_root??plan.sourceRoot):plan.sourceRoot};
    atomicFile(join(control,'latest.json'),Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
    return {ok:true,receipt,plan:publicPlan(plan)};
  } catch(error) {
    const recovery=restoreEntries(entries,folder);
    journal.status='failed';journal.error=error.message;journal.recovery=recovery;
    atomicFile(join(folder,'manifest.json'),Buffer.from(JSON.stringify(journal,null,2)+'\n'));
    return {ok:false,code:error.message,recovery,backup_dir:folder};
  } finally {unlinkSync(lock);}
}
export function latestReceipt(appDir) {
  try {return JSON.parse(readFileSync(join(appDir,'setup','latest.json'),'utf8'));} catch {return null;}
}
export function rollbackSetup(appDir,id) {
  const receipt=latestReceipt(appDir);
  if(!receipt||receipt.id!==id) return {ok:false,code:'receipt_not_current'};
  const folder=resolve(receipt.backup_dir),base=resolve(appDir,'backups'),path=join(folder,'manifest.json');
  if(!relative(base,folder)||relative(base,folder).startsWith('..')||isAbsolute(relative(base,folder))) return {ok:false,code:'invalid_receipt'};
  const bytes=readFileSync(path);
  if(hash(bytes)!==receipt.manifest_hash) return {ok:false,code:'receipt_modified'};
  const journal=JSON.parse(bytes);
  const recovery=restoreEntries(journal.entries,folder);
  if(!recovery.skipped.length) {
    receipt.status='rolled_back';atomicFile(join(appDir,'setup','latest.json'),Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
  }
  return {ok:recovery.skipped.length===0,...recovery,monitoring_data:'preserved'};
}
