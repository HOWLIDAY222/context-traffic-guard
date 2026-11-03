import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {parseWindows,parseMac,parseLinux,selectInterface,readSystemInterfaces} from './system-traffic.mjs';
import {openStore,ingest,storeSystemSnapshot,storeTrafficSnapshot,summarize,DEFAULTS} from './guard.mjs';
import {localRequestOptions,readConnections} from './traffic.mjs';

test('Windows adapter counters accept single or multiple JSON rows, retaining exact interface names',()=>{
  const row={Name:'无线网卡',ReceivedBytes:1200,SentBytes:3400};
  assert.deepEqual(parseWindows(JSON.stringify(row)),[{name:'无线网卡',downloadTotal:1200,uploadTotal:3400}]);
  assert.equal(parseWindows(JSON.stringify([row,{...row,Name:'Ethernet'}])).length,2);
  assert.throws(()=>parseWindows('{"Name":"Ethernet","SentBytes":1}'));
});

test('Linux parsing uses received/transmitted bytes, with no summing of physical and tunnel interfaces',()=>{
  const rows=parseLinux('Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n'+
    ' eth0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n'+
    ' tun0: 500 1 0 0 0 0 0 0 600 2 0 0 0 0 0 0');
  assert.equal(selectInterface(rows,'eth0','linux').uploadTotal,2000);
  assert.equal(selectInterface(rows,'tun0','linux').uploadTotal,600);
  assert.throws(()=>selectInterface(rows,''));
  assert.throws(()=>selectInterface(rows,'missing'));
  assert.throws(()=>parseLinux('eth0: 100 200'));
});

test('macOS parsing counts a link-layer row once and ignores repeated IPv4/IPv6 address rows',()=>{
  const rows=parseMac('Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n'+
    'en0 1500 <Link#4> aa:bb:cc:dd:ee:ff 10 0 1234 20 0 5678 0\n'+
    'en0 1500 192.0.2 192.0.2.1 10 - 1234 20 - 5678 -\n'+
    'en0 1500 fe80::1%en0 fe80::1 10 - 1234 20 - 5678 -\n'+
    'en1* 1500 <Link#5> aa:bb:cc:dd:ee:00 0 0 0 0 0 0 0\n'+
    'utun0 1380 <Link#6> 10 0 100 20 0 200 0');
  assert.equal(rows.length,3);
  assert.equal(selectInterface(rows,'en0','darwin').uploadTotal,5678);
  assert.equal(rows[1].name,'en1');
  assert.equal(rows[2].uploadTotal,200);
  assert.throws(()=>parseMac('Name Mtu Network Address Ipkts Opkts\nen0 1500 <Link#4> aa 1 2'));
});

test('invalid counters are unknown rather than coerced to zero or unsafe numbers',()=>{
  for(const value of [null,-1,NaN,9007199254740992,'1.5',''])
    assert.throws(()=>parseWindows(JSON.stringify({Name:'NIC',ReceivedBytes:value,SentBytes:1})));
  assert.throws(()=>selectInterface([{name:'same'},{name:'same'}],'same'));
});

test('system network counters cannot be attributed to Codex or mixed across interfaces and providers',()=>{
  const db=openStore(mkdtempSync(join(tmpdir(),'context-guard-system-'))), ts=1800000000000;
  ingest(db,{session_id:'s',hook_event_name:'SessionStart'},ts);
  const snap=(name,up,down)=>({name,platform:'linux',uploadTotal:up,downloadTotal:down});
  storeSystemSnapshot(db,snap('eth0',100,200),ts);
  storeTrafficSnapshot(db,{uploadTotal:999999,downloadTotal:888888,connections:[]},ts+100);
  storeSystemSnapshot(db,snap('eth0',300,600),ts+1000);
  let r=summarize(db,'s','root',ts+1000);
  assert.equal(r.traffic.provider,'system_interface');
  assert.equal(r.traffic.upload_bytes,200);
  assert.equal(r.traffic.download_bytes,400);
  assert.equal(r.traffic.codex_chatgpt_upload_lower_bound,null);
  assert(r.traffic.scope.includes('all programs'));
  storeSystemSnapshot(db,snap('wifi0',100000,100000),ts+2000);
  r=summarize(db,'s','root',ts+2000);
  assert.equal(r.traffic.interface,'wifi0');
  assert.equal(r.traffic.status,'unavailable');
  assert.equal(r.traffic.upload_bytes,undefined);
  db.close();
});

test('system resets and old samples never produce negative or cross-restart traffic',()=>{
  const db=openStore(mkdtempSync(join(tmpdir(),'context-guard-reset-'))), ts=1800000000000;
  ingest(db,{session_id:'s',hook_event_name:'SessionStart'},ts);
  const snap=up=>({name:'en0',platform:'darwin',uploadTotal:up,downloadTotal:up});
  storeSystemSnapshot(db,snap(9000),ts);
  storeSystemSnapshot(db,snap(10000),ts+1000);
  storeSystemSnapshot(db,snap(10),ts+2000);
  storeSystemSnapshot(db,snap(100000),ts-100);
  storeSystemSnapshot(db,snap(50),ts+3000);
  const r=summarize(db,'s','root',ts+3000,{...DEFAULTS,trafficUploadBytes:1});
  assert.equal(r.traffic.upload_bytes,40);
  assert(r.alerts.some(a=>a.kind==='traffic'&&a.message.includes('网卡')));
  db.close();
});

test('optional Mihomo transports accept loopback HTTP, Windows pipes and Unix sockets without remote access',()=>{
  assert.equal(localRequestOptions('http://127.0.0.1:9090').port,'9090');
  assert.equal(localRequestOptions('http://[::1]:9090').hostname,'::1');
  assert.equal(localRequestOptions('/tmp/controller.sock','darwin').socketPath,'/tmp/controller.sock');
  assert.equal(localRequestOptions('\\\\.\\pipe\\controller','win32').socketPath,'\\\\.\\pipe\\controller');
  for(const url of ['http://example.com:9090','https://127.0.0.1','http://user:secret@127.0.0.1',
    'http://127.0.0.1/?token=secret','http://127.0.0.1/other','http://127.0.0.1/#secret'])
    assert.throws(()=>localRequestOptions(url));
  assert.throws(()=>localRequestOptions('relative.sock','linux'));
});

test('loopback API is read-only, does not follow redirects and validates counters',async()=>{
  let mode='ok';
  const server=http.createServer((req,res)=>{
    assert.equal(req.method,'GET'); assert.equal(req.url,'/connections');
    if(mode==='redirect') {res.writeHead(302,{Location:'http://example.com/'});res.end();return;}
    res.end(JSON.stringify({uploadTotal:mode==='bad'?-1:100,downloadTotal:200,connections:[]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    assert.equal((await readConnections(url)).uploadTotal,100);
    mode='redirect';await assert.rejects(readConnections(url));
    mode='bad';await assert.rejects(readConnections(url));
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('native adapter enumeration returns actual byte counters on the executing OS',{timeout:20000},async()=>{
  const rows=await readSystemInterfaces();
  assert(rows.length>0);
  for(const row of rows) {
    assert.equal(typeof row.name,'string');
    assert(Number.isSafeInteger(row.uploadTotal));
    assert(Number.isSafeInteger(row.downloadTotal));
  }
});
