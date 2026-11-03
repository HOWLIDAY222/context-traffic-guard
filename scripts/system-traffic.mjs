import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const counter = value => {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('missing byte counter');
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('invalid byte counter');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid byte counter');
  return n;
};
const entry = (name, received, sent) => {
  if (typeof name !== 'string' || !name || name.length > 256) throw new Error('invalid interface');
  return { name, downloadTotal: counter(received), uploadTotal: counter(sent) };
};

export function parseWindows(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  return (Array.isArray(data) ? data : data ? [data] : []).map(
    row => entry(row.Name, row.ReceivedBytes, row.SentBytes));
}

export function parseLinux(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const values = match[2].trim().split(/\s+/);
    if (values.length !== 16) throw new Error('unsupported /proc/net/dev row');
    rows.push(entry(match[1].trim(), values[0], values[8]));
  }
  return rows;
}

export function parseMac(text) {
  let header;
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const values = line.trim().split(/\s+/);
    if (values[0] === 'Name') { header = values; continue; }
    if (!header || !values[header.indexOf('Network')]?.startsWith('<Link#')) continue;
    // Loopback / tunnel interfaces can have an empty link address column.
    if (values.length === header.length-1 && header.indexOf('Address') === 3) values.splice(3,0,'');
    const input = header.indexOf('Ibytes'), output = header.indexOf('Obytes');
    if (input < 0 || output < 0 || values.length !== header.length)
      throw new Error('unsupported netstat byte columns');
    // Address-specific rows repeat counters; only the single link-layer row counts.
    const name = values[0].replace(/\*$/, '');
    if (rows.has(name)) throw new Error('ambiguous interface rows');
    rows.set(name, entry(name, values[input], values[output]));
  }
  if (!header?.includes('Ibytes') || !header.includes('Obytes'))
    throw new Error('netstat byte counters unavailable');
  return [...rows.values()];
}

export async function readSystemInterfaces({platform = process.platform} = {}) {
  if (platform === 'linux') return parseLinux(await readFile('/proc/net/dev', 'utf8'));
  const options = {encoding:'utf8', timeout:10000, maxBuffer:1048576, windowsHide:true};
  if (platform === 'darwin') {
    const {stdout} = await execute('/usr/sbin/netstat', ['-ibn'], options);
    return parseMac(stdout);
  }
  if (platform === 'win32') {
    // Constant script: interface names are never interpolated into shell code.
    const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' +
      'Get-NetAdapterStatistics -ErrorAction Stop | ' +
      'Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress';
    const {stdout} = await execute('powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], options);
    return parseWindows(stdout);
  }
  throw new Error('system network counters unsupported on this platform');
}

export function selectInterface(rows, name, platform = process.platform) {
  if (typeof name !== 'string' || !name) throw new Error('explicit interface name required');
  const matches = rows.filter(row => row.name === name);
  if (matches.length !== 1) throw new Error('selected interface unavailable or ambiguous');
  return {...matches[0], platform};
}

async function main() {
  const command = process.argv[2], args = {};
  for (let i=3; i<process.argv.length; i+=2) {
    if (!process.argv[i].startsWith('--') || process.argv[i+1] == null)
      throw new Error('expected named argument and value');
    args[process.argv[i].slice(2)] = process.argv[i+1];
  }
  if (command === 'list') {
    process.stdout.write(JSON.stringify({platform:process.platform,
      interfaces:(await readSystemInterfaces()).map(row => ({name:row.name})),
      scope:'select one intended interface; physical, VPN and loopback counters must not be added'}, null, 2));
    return;
  }
  if (command !== 'sample' || !args.interface || !args['state-dir'])
    throw new Error('use list, or sample with --interface and --state-dir');
  const seconds = Number(args.seconds ?? 30), interval = Number(args['interval-ms'] ?? 5000);
  if (!(seconds > 0 && seconds <= 86400 && interval >= 1000 && interval <= 60000))
    throw new Error('invalid sampling bounds');
  const {openStore, storeSystemSnapshot} = await import('./guard.mjs');
  const db = openStore(resolve(args['state-dir']));
  const stopAt = Date.now() + seconds*1000;
  let samples=0, failures=0, first=null, last=null, resets=0;
  try {
    while (Date.now() < stopAt) {
      try {
        const snapshot=selectInterface(await readSystemInterfaces(), args.interface);
        const ts=Date.now();
        if (last && (snapshot.uploadTotal<last.uploadTotal || snapshot.downloadTotal<last.downloadTotal)) resets++;
        storeSystemSnapshot(db,snapshot,ts);
        first ??= {...snapshot,ts}; last={...snapshot,ts}; samples++;
      } catch { failures++; }
      const remaining=stopAt-Date.now();
      if (remaining>0) await new Promise(r=>setTimeout(r,Math.min(interval,remaining)));
    }
  } finally { db.close(); }
  process.stdout.write(JSON.stringify({provider:'system_interface', interface:args.interface,
    platform:process.platform, samples, failures, resets,
    seconds:first&&last?(last.ts-first.ts)/1000:null,
    upload_bytes:samples>=2&&!resets?last.uploadTotal-first.uploadTotal:null,
    download_bytes:samples>=2&&!resets?last.downloadTotal-first.downloadTotal:null,
    scope:'all programs using the selected interface; not per-process or per-chat'},null,2));
  if (!samples) process.exitCode=1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(()=>{process.stderr.write('system network observation unavailable.\n');process.exitCode=1;});
