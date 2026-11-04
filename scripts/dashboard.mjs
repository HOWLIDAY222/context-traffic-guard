import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { CLIENTS } from './adapters.mjs';
import { loadPolicy } from './guard.mjs';
import { withStore, sessionsIn, sessionData, readHandoffSeed } from './dashboard-data.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
export function createDashboard({stateDir,policy,initial={},handoffPath,assetsDir=join(ROOT,'dashboard','dist'),stateSources=[],setupController=null,instanceId=null}) {
  const sources=()=>{
    const supplied=typeof stateSources==='function'?stateSources():stateSources;
    const paths=[typeof stateDir==='function'?stateDir():stateDir,...supplied.map(s=>s.path)].filter(Boolean);
    return [...new Set(paths)].map(path=>({id:createHash('sha256').update(path).digest('hex').slice(0,16),label:path,path}));
  };
  const server=createServer(async(req,res)=>{
    const origin='http://127.0.0.1:'+server.address().port;
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
    const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
    if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site') return send(403,{ok:false,code:'local_origin_required'});
    try {
      const url=new URL(req.url,origin);
      if(req.method!=='GET') {
        const allowed=['/api/setup/apply','/api/setup/rollback','/api/setup/network','/api/setup/reload'];
        if(req.method!=='POST'||!setupController||!allowed.includes(url.pathname))return send(405,{ok:false,code:'read_only'});
        if(req.headers['x-ctg-setup-token']!==setupController.token||!req.headers['content-type']?.startsWith('application/json'))return send(403,{ok:false,code:'setup_token_required'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>32768)return send(413,{ok:false,code:'body_too_large'});chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{ok:false,code:'invalid_json'});}
        const result=url.pathname==='/api/setup/apply'?await setupController.apply(body.plan_id):url.pathname==='/api/setup/rollback'?setupController.rollback(body.receipt_id):url.pathname==='/api/setup/reload'?setupController.reload():await setupController.networkAction(body);
        return send(result.ok?200:409,result);
      }
      if(url.pathname==='/api/health')return send(200,{app:'context-traffic-guard',protocol:2,instance_id:instanceId??setupController?.instanceId??null});
      if(url.pathname==='/api/setup')return setupController?send(200,{ok:true,...setupController.status()}):send(200,{ok:true,available:false});
      if(url.pathname==='/api/setup/scan')return setupController?send(200,{ok:true,...setupController.scan()}):send(405,{ok:false,code:'setup_not_enabled'});
      if(url.pathname==='/api/setup/interfaces')return setupController?send(200,{ok:true,interfaces:await setupController.interfaces()}):send(405,{ok:false,code:'setup_not_enabled'});
      const knownSources=sources(),sourceId=url.searchParams.get('source'),source=sourceId?knownSources.find(s=>s.id===sourceId):knownSources[0];
      if(url.pathname.startsWith('/api/')&&!source)return send(400,{ok:false,code:'unknown_state_source'});
      if(url.pathname==='/api/bootstrap') {
        const data=withStore(source.path,db=>({sessions:sessionsIn(db)}));
        const sessions=data.sessions??[];
        const selected=initial.session?sessions.find(s=>s.client===initial.client&&s.raw_session===initial.session&&s.agent===(initial.agent??'root')&&(s.client!=='generic'||s.source===(initial.source??'custom'))):null;
        return send(200,{...data,sessions,clients:CLIENTS,state_path:source.path,initial_key:selected?.key??null,
          state_sources:knownSources,active_source:source.id,setup:setupController?setupController.status():null,
          initial_unmatched:!!initial.session&&!selected,poll_ms:5000,generated_at:Date.now()});
      }
      if(url.pathname==='/api/session') {
        const key=url.searchParams.get('key'), minutes=Number(url.searchParams.get('minutes')??30);
        if(![0,30,120].includes(minutes)||!key) return send(400,{ok:false,code:'invalid_selection'});
        const now=Date.now();
        const result=withStore(source.path,db=>{
          const selection=sessionsIn(db).find(s=>s.key===key);
          if(!selection) return {missing:true};
          return {...sessionData(db,key,minutes,now,policy),seed:readHandoffSeed(handoffPath,selection)};
        });
        if(result.missing) return send(404,{ok:false,code:'session_not_found'});
        return send(200,{...result,generated_at:now,policy});
      }
      const path=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).slice(1);
      if(path.includes('..')||path.includes('\\')||!Object.hasOwn(mime,extname(path))) return send(404,{ok:false,code:'not_found'});
      let content;
      try {content=readFileSync(join(typeof assetsDir==='function'?assetsDir():assetsDir,path));} catch {return send(404,{ok:false,code:'asset_not_found',message:'请使用仓库附带的 dashboard/dist，或先运行 pnpm build。'});}
      return send(200,content,mime[extname(path)]);
    } catch {return send(503,{ok:false,code:'observation_unavailable',message:'本地记录暂时不可读；采集与任务不受影响，请稍后刷新。'});}
  });
  return server;
}
async function main() {
  const args={};
  for(let i=2;i<process.argv.length;i+=2) {
    const key=process.argv[i];
    if(!['--state-dir','--port','--client','--session','--source','--agent','--handoff','--policy'].includes(key)||!process.argv[i+1]) throw new Error('Invalid arguments');
    args[key.slice(2)]=process.argv[i+1];
  }
  const port=Number(args.port??43871);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid port');
  if(args.session&&(!args.client||!Object.hasOwn(CLIENTS,args.client))) throw new Error('Explicit --client required with --session');
  const stateDir=resolve(args['state-dir']??join(homedir(),'.context-traffic-guard'));
  const policy=loadPolicy(args.policy??join(ROOT,'integration','policy.json'));
  const server=createDashboard({stateDir,policy,initial:{client:args.client,session:args.session,agent:args.agent,source:args.source},handoffPath:args.handoff?resolve(args.handoff):undefined});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  process.stdout.write('Context Guard: http://127.0.0.1:'+port+'\nLocal read-only panel. Stop with Ctrl+C.\n');
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{process.stderr.write('Context Guard: panel could not start. Check arguments or choose a free --port.\n');process.exitCode=1;});
