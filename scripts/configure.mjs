import { realpathSync } from 'node:fs';
import {resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const quote = value => {
  const path=String(value).replace(/\\/g,'/');
  if(/["\r\n$`%!]/.test(path)) throw new Error('path requires manual shell quoting');
  return '"'+path+'"';
};
export function buildConfig({client,skillDir,stateDir,node=process.execPath,detailed=false,mode='hooks',shell='auto'}) {
  if(!skillDir||!stateDir) throw new Error('explicit paths required');
  const script=quote(skillDir.replace(/\\/g,'/')+'/scripts/guard.mjs');
  const common=' --client '+client+' --state-dir '+quote(stateDir);
  const executable=String(node).replace(/\\/g,'/');
  quote(executable); // Validate paths before producing any shell text.
  let prefix;
  if(shell==='powershell') prefix='& '+quote(executable);
  else if(['posix','cmd'].includes(shell)) prefix=quote(executable);
  else if(shell==='auto'&&/^[\p{L}\p{N}_./:\-]+$/u.test(executable)) prefix=executable;
  else throw new Error('choose --shell posix, powershell or cmd for this executable path');
  if(mode==='statusline') {
    const command=prefix+' --no-warnings '+script+' statusline'+common;
    if(client==='claude') return {statusLine:{type:'command',command}};
    if(client==='grok') return '[ui.status_line]\ntype = "command"\ncommand = '+JSON.stringify(command)+'\n';
    throw new Error('this client has no implemented statusline contract');
  }
  const events={
    codex:['SessionStart','PreCompact','PostCompact','PreModelRequest','PostModelRequest','UserPromptSubmit','PostToolUse','Stop'],
    claude:['SessionStart','PreCompact','PostCompact','UserPromptSubmit','PostToolUse','Stop'],
    gemini:['SessionStart','PreCompress','BeforeAgent','AfterAgent','AfterTool',...(detailed?['BeforeModel','AfterModel']:[])],
    grok:['SessionStart','PreCompact','PostCompact','UserPromptSubmit','PostToolUse','Stop','StopFailure'],
  }[client];
  if(!events) throw new Error('use the generic event API for a custom client');
  const command=prefix+' --no-warnings '+script+' hook'+common;
  return {hooks:Object.fromEntries(events.map(event=>[event,[{hooks:[{
    type:'command',command,timeout:client==='gemini'?3000:3,
    ...(client==='codex'&&['UserPromptSubmit','PostToolUse'].includes(event)?{additionalContextLimit:512}:{})
  }]}]]))};
}

function main() {
  const mode=process.argv[2]??'hooks', args={};
  for(let i=3;i<process.argv.length;i++) {
    const name=process.argv[i];
    if(name==='--detailed') args.detailed=true;
    else if(name.startsWith('--')&&process.argv[i+1]!=null) args[name.slice(2)]=process.argv[++i];
    else throw new Error('invalid argument');
  }
  const output=buildConfig({client:args.client,mode,detailed:args.detailed,
    skillDir:args['skill-dir']??resolve(dirname(fileURLToPath(import.meta.url)),'..'),
    stateDir:args['state-dir']??resolve(homedir(),'.context-traffic-guard'),node:args.node??process.execPath,shell:args.shell??'auto'});
  process.stdout.write(typeof output==='string'?output:JSON.stringify(output,null,2)+'\n');
}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))
  try {main();} catch {process.stderr.write('configuration generation failed; check client, paths and --shell (posix/powershell/cmd). No settings were changed.\n');process.exitCode=1;}
