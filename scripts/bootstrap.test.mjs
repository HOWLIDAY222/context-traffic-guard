import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,chmodSync } from 'node:fs';
import { join,resolve,dirname,basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { SOURCE_ROOT } from './setup-engine.mjs';

test('first launch without Node prepares a verified official runtime and performs the requested dry run',
  {skip:process.env.CTG_TEST_BOOTSTRAP_DOWNLOAD!=='1',timeout:360000},t=>{
    const base=mkdtempSync(join(tmpdir(),'ctg-bootstrap-')),home=join(base,'User Space');mkdirSync(join(home,'.codex'),{recursive:true});
    t.after(()=>{assert.equal(dirname(resolve(base)),resolve(tmpdir()));assert(basename(base).startsWith('ctg-bootstrap-'));rmSync(base,{recursive:true,force:true});});
    const bin=join(base,'bin');mkdirSync(bin);
    const env={...process.env,CTG_NODE:'',HOME:home,USERPROFILE:home};
    let result;
    if(process.platform==='win32') {
      env.PATH=join(process.env.SystemRoot,'System32');env.Path=env.PATH;
      const cmd='""'+join(SOURCE_ROOT,'Start-Context-Guard.cmd')+'" --home "'+home+'" --plan"';
      result=spawnSync(join(process.env.SystemRoot,'System32/cmd.exe'),['/d','/s','/c',cmd],{env,encoding:'utf8',timeout:340000,windowsHide:true,windowsVerbatimArguments:true});
    } else {
      writeFileSync(join(bin,'node'),'#!/bin/sh\nprintf "20\\n"\n',{mode:0o700});
      env.PATH=bin+':'+process.env.PATH;
      result=spawnSync('/bin/bash',[join(SOURCE_ROOT,'start-context-guard.sh'),'--home',home,'--plan'],{env,encoding:'utf8',timeout:340000});
    }
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
    const index=result.stdout.indexOf('{'),plan=JSON.parse(result.stdout.slice(index));assert(plan.node_version.startsWith('24.'));assert(plan.can_apply);
    const runtime=join(home,'.context-traffic-guard/runtime');assert(existsSync(runtime));assert(readdirSync(runtime).some(n=>n.startsWith('node-v24.')));
    assert(!existsSync(join(home,'.codex/hooks.json')),'dry run must not install hooks');
  });

test('POSIX bootstrap rejects a mismatched archive before extraction or execution',
  {skip:process.platform==='win32',timeout:10000},t=>{
    const base=mkdtempSync(join(tmpdir(),'ctg-bootstrap-')),home=join(base,'home'),bin=join(base,'bin');mkdirSync(bin);mkdirSync(home);
    t.after(()=>{assert.equal(dirname(resolve(base)),resolve(tmpdir()));assert(basename(base).startsWith('ctg-bootstrap-'));rmSync(base,{recursive:true,force:true});});
    writeFileSync(join(bin,'node'),'#!/bin/sh\nprintf "20\\n"\n',{mode:0o700});
    const platform=process.platform==='darwin'?'darwin':'linux',arch=process.arch==='arm64'?'arm64':'x64';
    const curl='#!/bin/sh\nctg_out=""; ctg_url=""\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift; ctg_out="$1";; https:*) ctg_url="$1";; esac; shift; done\ncase "$ctg_url" in *SHASUMS256.txt) printf "'+ '0'.repeat(64)+'  node-v24.99.0-'+platform+'-'+arch+'.tar.gz\\n" > "$ctg_out";; *) printf "tampered" > "$ctg_out";; esac\n';
    writeFileSync(join(bin,'curl'),curl,{mode:0o700});
    const result=spawnSync('/bin/bash',[join(SOURCE_ROOT,'start-context-guard.sh'),'--home',home,'--plan'],{env:{...process.env,HOME:home,CTG_NODE:'',PATH:bin+':'+process.env.PATH},encoding:'utf8',timeout:8000});
    assert.notEqual(result.status,0);assert(result.stderr.includes('checksum mismatch'));assert(!existsSync(join(home,'.context-traffic-guard/skill')));
  });
