import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse, modify, applyEdits, parseToml } from '../vendor/setup-codecs.mjs';
import { buildConfig } from './configure.mjs';

export const CLIENT_IDS=['codex','claude','gemini','grok'];
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const safeCode=error=>/^[a-z_]{1,80}$/.test(error?.message??'')?error.message:'invalid_settings';
export function readOptional(path) {
  if(!existsSync(path)) return null;
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2097152) throw new Error('unsupported_config_file');
  return readFileSync(path);
}
export function parseSettings(bytes) {
  const errors=[],value=parse((bytes?.toString('utf8')??'{}').replace(/^\uFEFF/,''),errors,{allowTrailingComma:true});
  if(errors.length||!value||typeof value!=='object'||Array.isArray(value)) throw new Error('invalid_settings');
  return value;
}
export function patchSettings(text,path,value) {
  const original=text??'{}\n',bom=original.startsWith('\uFEFF')?'\uFEFF':'';
  const body=original.slice(bom.length);
  return bom+applyEdits(body,modify(body,path,value,{formattingOptions:{insertSpaces:true,tabSize:2,eol:original.includes('\r\n')?'\r\n':'\n'}}));
}
function executable(name,env,platform) {
  const separator=platform==='win32'?';':delimiter;
  const suffixes=platform==='win32'?['.exe','.cmd','.bat','']:[''];
  for(const folder of (env.PATH??env.Path??'').split(separator).filter(Boolean))
    for(const suffix of suffixes) if(existsSync(join(folder,name+suffix))) return join(folder,name+suffix);
  return null;
}
export function detectClients({home=homedir(),env=process.env,platform=process.platform}={}) {
  const roots={codex:resolve(env.CODEX_HOME??join(home,'.codex')),claude:resolve(env.CLAUDE_CONFIG_DIR??join(home,'.claude')),
    gemini:resolve(env.GEMINI_CLI_HOME??home,'.gemini'),grok:resolve(home,'.grok')};
  return CLIENT_IDS.map(id=>{
    const binary=executable(id==='claude'?'claude':id,env,platform),root=roots[id];
    const reasons=[];
    if(existsSync(root)) reasons.push('配置目录');
    if(binary) reasons.push('命令入口');
    if(id==='codex'&&env.CODEX_THREAD_ID) reasons.push('当前 Codex 会话');
    const path=id==='codex'?join(root,'hooks.json'):id==='grok'?join(root,'hooks','context-traffic-guard.json'):join(root,'settings.json');
    return {id,root,path,detected:reasons.length>0,reasons};
  });
}
const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const psQuote=value=>"'"+String(value).replaceAll("'","''")+"'";
const winQuote=value=>'"'+String(value).replace(/(\\*)"/g,(_,slashes)=>slashes+slashes+'\\"').replace(/(\\+)$/,'$1$1')+'"';
export function commandOf(argv,platform=process.platform) {
  if(argv.some(s=>/[\u0000\r\n]/.test(s))) throw new Error('unsupported_path');
  if(platform!=='win32') return argv.map(shellQuote).join(' ');
  const script="$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "+
    '$ctgInfo = New-Object System.Diagnostics.ProcessStartInfo; $ctgInfo.FileName = '+psQuote(argv[0])+'; '+
    '$ctgInfo.Arguments = '+psQuote(argv.slice(1).map(winQuote).join(' '))+'; '+
    '$ctgInfo.UseShellExecute = $false; $ctgInfo.CreateNoWindow = $true; '+
    '$ctgInfo.RedirectStandardInput = $true; $ctgInfo.RedirectStandardOutput = $true; $ctgInfo.RedirectStandardError = $true; '+
    '$ctgProcess = [System.Diagnostics.Process]::Start($ctgInfo); '+
    '$ctgOut = $ctgProcess.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()); '+
    '$ctgErr = $ctgProcess.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError()); '+
    '[Console]::OpenStandardInput().CopyTo($ctgProcess.StandardInput.BaseStream); $ctgProcess.StandardInput.Close(); '+
    '$ctgProcess.WaitForExit(); [void]$ctgOut.GetAwaiter().GetResult(); [void]$ctgErr.GetAwaiter().GetResult(); exit $ctgProcess.ExitCode';
  const command='powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64');
  if(command.length>7000) throw new Error('command_too_long');
  return command;
}
export function unpackCommand(command) {
  if(typeof command!=='string') return '';
  const encoded=/-EncodedCommand\s+([A-Za-z0-9+/=]+)\s*$/i.exec(command);
  return encoded?Buffer.from(encoded[1],'base64').toString('utf16le'):command;
}
export function owned(hook) {
  const command=unpackCommand(hook?.command),args=Array.isArray(hook?.args)?hook.args:[];
  return command.includes('--ctg-owner')&&command.includes('context-traffic-guard-v1')||args.includes('--ctg-owner')||
    /context-traffic-guard[^/\\"']*[/\\]scripts[/\\]guard\.mjs/.test(command);
}
export function stateOf(hook) {
  if(Array.isArray(hook.args)) {
    const i=hook.args.indexOf('--state-dir');if(i>=0&&isAbsolute(hook.args[i+1]??'')) return resolve(hook.args[i+1]);
  }
  const command=unpackCommand(hook.command);
  const encoded=/(?:'--ctg-state-b64'|"--ctg-state-b64"|--ctg-state-b64)\s+["']?([A-Za-z0-9_-]+)/.exec(command);
  if(encoded){const path=Buffer.from(encoded[1],'base64url').toString('utf8');if(isAbsolute(path))return resolve(path);}
  const match=/(?:'--state-dir'|"--state-dir"|--state-dir)\s+(?:"([^"]*)"|'((?:[^']|'')*)'|([^\s]+))/.exec(command);
  const value=match?(match[1]??match[2]?.replaceAll("''","'")??match[3]):null;
  return value&&isAbsolute(value)?resolve(value):null;
}
export function hookHandlers(config) {
  return Object.entries(config.hooks??{}).flatMap(([event,groups])=>Array.isArray(groups)?groups.flatMap(g=>Array.isArray(g?.hooks)?g.hooks.map(h=>({event,hook:h})):[]):[]);
}
function configurationSources(client) {
  const main=readOptional(client.path),sources=[{path:client.path,bytes:main,kind:'json',value:parseSettings(main)}];
  if(client.id==='codex') {
    const path=join(client.root,'config.toml'),bytes=readOptional(path);
    if(bytes) {
      const value=parseToml(bytes.toString('utf8'));
      if(value.hooks) sources.push({path,bytes,kind:'toml',value});
    }
  }
  if(client.id==='grok'&&existsSync(join(client.root,'hooks'))) {
    const names=readdirSync(join(client.root,'hooks')).filter(n=>n.endsWith('.json')&&n!=='context-traffic-guard.json');
    if(names.length>50) throw new Error('too_many_hook_sources');
    for(const name of names) {
      const path=join(client.root,'hooks',name),bytes=readOptional(path);
      sources.push({path,bytes,kind:'json',value:parseSettings(bytes)});
    }
  }
  for(const source of sources) if(source.value.hooks!=null&&(typeof source.value.hooks!=='object'||Array.isArray(source.value.hooks))) throw new Error('invalid_hook_structure');
  return sources;
}
export function inspectClient(client) {
  try {
    const sources=configurationSources(client),all=sources.flatMap(s=>hookHandlers(s.value)),ours=all.filter(h=>owned(h.hook));
    const dirs=[...new Set(ours.map(h=>stateOf(h.hook)).filter(Boolean))];
    if(dirs.length>1) throw new Error('multiple_states_in_one_client');
    const disabled=sources.some(s=>s.value.disableAllHooks===true||s.value.hooksConfig?.enabled===false||
      s.value.hooksConfig?.disabled?.includes('context-traffic-guard'));
    return {...client,sources,ours,existingState:dirs[0]??null,proxySampling:ours.some(h=>unpackCommand(h.hook.command).includes('--sample-traffic')),disabled};
  } catch(error) {return {...client,error:safeCode(error)};}
}
export function mergeClient(client,{stateDir,skillDir,node=process.execPath,platform=process.platform,detailed=false}) {
  if(client.error||client.disabled) return {operations:[],status:'blocked',reason:client.error??'hooks_disabled_by_user',events:[],notes:[]};
  const template=buildConfig({client:client.id,skillDir:'/ctg',stateDir:'/ctg-state',node:'/node',detailed,shell:'posix'});
  const events=Object.keys(template.hooks),existing=new Set(client.ours.map(h=>h.event));
  const missing=events.filter(e=>!existing.has(e)),operations=[],notes=[];
  const args=[node,'--no-warnings',join(skillDir,'scripts','guard.mjs'),'hook','--client',client.id,'--state-dir',stateDir,'--ctg-owner','context-traffic-guard-v1','--ctg-state-b64',Buffer.from(stateDir).toString('base64url')];
  const command=commandOf(args,platform);
  if(missing.length) {
    const target=client.sources.find(s=>s.kind==='toml')??client.sources[0];
    let after=target.bytes?.toString('utf8')??'{}\n';
    if(target.kind==='toml') {
      const eol=after.includes('\r\n')?'\r\n':'\n';
      for(const event of missing) {
        if(target.value.hooks?.[event]!==undefined&&!Array.isArray(target.value.hooks[event])) throw new Error('invalid_hook_structure');
        after+=eol+'[[hooks.'+event+']]'+eol+'[[hooks.'+event+'.hooks]]'+eol+'type = "command"'+eol+'command = '+JSON.stringify(command)+eol+'timeout = 3'+eol;
      }
      parseToml(after);
    } else {
      for(const event of missing) {
        const groups=parseSettings(Buffer.from(after)).hooks?.[event]??[];
        if(!Array.isArray(groups)) throw new Error('invalid_hook_structure');
        const handler={...template.hooks[event][0].hooks[0],command};
        if(client.id==='gemini') handler.name='context-traffic-guard';
        after=patchSettings(after,['hooks',event],[...groups,{hooks:[handler]}]);
      }
      parseSettings(Buffer.from(after));
    }
    operations.push({path:target.path,before:target.bytes,after:Buffer.from(after),kind:'hooks',client:client.id});
  }
  if(client.id==='claude') {
    const source=client.sources[0],op=operations.find(o=>o.path===source.path),text=(op?.after??source.bytes)?.toString('utf8')??'{}\n';
    const settings=parseSettings(Buffer.from(text));
    if(settings.statusLine===undefined) {
      const statusLine={type:'command',command:commandOf([node,'--no-warnings',join(skillDir,'scripts','guard.mjs'),'statusline','--client','claude','--state-dir',stateDir,'--ctg-owner','context-traffic-guard-v1'],platform)};
      const after=Buffer.from(patchSettings(text,['statusLine'],statusLine));
      if(op) op.after=after;else operations.push({path:source.path,before:source.bytes,after,kind:'statusline',client:client.id});
      notes.push('将接入上下文状态栏');
    } else notes.push(owned(settings.statusLine)?'沿用已有监测状态栏':'保留原有状态栏；上下文快照可能不可用');
  }
  if(client.id==='grok') {
    const path=join(client.root,'config.toml'),before=readOptional(path),text=before?.toString('utf8')??'';
    const config=parseToml(text);
    if(config.ui?.status_line!==undefined) notes.push('保留已有 Grok 状态栏');
    else if(platform==='win32') notes.push('Grok Windows 命令状态栏尚未验证；使用面板查看基础事件');
    else {
      const command=commandOf([node,'--no-warnings',join(skillDir,'scripts','guard.mjs'),'statusline','--client','grok','--state-dir',stateDir,'--ctg-owner','context-traffic-guard-v1'],platform);
      const after=text+'\n[ui.status_line]\ntype = "command"\ncommand = '+JSON.stringify(command)+'\n';
      try {parseToml(after);operations.push({path,before,after:Buffer.from(after),kind:'statusline',client:'grok'});notes.push('将接入 Grok 状态栏；无会话 ID 时不绑定数据');}
      catch {notes.push('现有 TOML 结构需单独合并状态栏，基础事件不受影响');}
    }
  }
  return {operations,status:operations.length?'pending_write':'reused',events,notes};
}
