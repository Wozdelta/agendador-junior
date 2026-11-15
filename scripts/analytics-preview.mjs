// Isolated visual QA. Localhost only; no production API, OAuth, credentials or storage.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('web/dist'),platforms=['facebook','youtube','instagram','tiktok'];
let scenario='four';
const metric=(value,basis='period')=>({value,state:value===null?'unavailable':'available',basis,source:'FIXTURE LOCAL — DADOS SIMULADOS'});
function data(start='2026-10-18',end='2026-11-14') {
  return {start,end,platforms:platforms.map((p,i)=>{
    const missing=scenario==='none'||scenario==='partial'&&i>1;
    const state=missing?'disconnected':scenario==='expired'&&i===3?'expired':scenario==='permission'&&i===2?'permission':'available';
    const metrics={followers:metric(scenario==='zero'?0:1200+i*357,'current'),gained:metric(51+i*5),lost:metric(4),net:metric(47+i*5),views:metric(scenario==='zero'?0:25200+i*7100),likes:metric(920),comments:metric(35),shares:metric(81),saves:metric(p==='instagram'?47:null),reach:metric(p==='instagram'?12000:null),watchHours:metric(p==='youtube'?342:null),averageSeconds:metric(p==='youtube'?42:null),revenue:p==='youtube'?{...metric(32.15),currency:'USD'}:metric(null)};
    return {platform:p,state,accountId:missing?undefined:p,accountName:missing?undefined:['Página Junior','Canal Junior','@junior.reels','Junior no TikTok'][i],missingScopes:state==='permission'?['instagram_manage_insights']:[],lastSuccess:missing?undefined:'2026-11-15T12:00:00Z',collectionStartedAt:'2026-11-01',snapshots:missing?[]:Array.from({length:14},(_,n)=>({date:`2026-11-${String(n+1).padStart(2,'0')}`,value:scenario==='zero'?0:1000+i*200+n*12})),report:missing?undefined:{platform:p,accountId:p,accountName:p,start,end,collectedAt:'2026-11-15T12:00:00Z',timezone:p==='youtube'?'America/Los_Angeles':'UTC',metrics,daily:[],notes:['DADOS SIMULADOS EXCLUSIVOS DA PRÉVIA LOCAL.'],complete:false,content:Array.from({length:3},(_,n)=>({id:`${p}-${n}`,title:`Uma ideia que virou história · episódio ${n+1}`,url:'https://example.test/',platform:p,publishedAt:'2026-11-12T12:00:00Z',basis:p==='youtube'?'period':'lifetime',metrics:{views:metric(5200-n*1150),likes:metric(125-n*30),comments:metric(12),shares:metric(9)}}))}};
  })};
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.searchParams.has('scenario'))scenario=url.searchParams.get('scenario');
  res.setHeader('Cache-Control','no-store');
  if(url.pathname.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');
    const analytics=data(url.searchParams.get('start')??undefined,url.searchParams.get('end')??undefined);
    const payload=url.pathname==='/api/auth/session'?{user:{id:'fixture',email:'preview@example.test'}}:url.pathname==='/api/settings'?{mode:'real',timezone:'America/Sao_Paulo',publishTime:'12:00',serverPersistence:true,mediaPersistence:true}:url.pathname==='/api/connections'?analytics.platforms.map(p=>({platform:p.platform,connected:p.state!=='disconnected',configured:true,canConnect:true,accountId:p.accountId,accountName:p.accountName,needsReconnect:scenario==='expired'&&p.platform==='tiktok',capabilities:['manual'],notes:['DADOS SIMULADOS DA PRÉVIA LOCAL'],analytics:{state:p.state,missingScopes:p.missingScopes,lastSync:p.lastSuccess}})):url.pathname==='/api/analytics'?analytics:url.pathname.endsWith('/sync')?{state:'available'}:url.pathname==='/api/manual'?{rows:[]}:url.pathname==='/api/tasks'?{tasks:[],drafts:[]}:{};
    res.end(JSON.stringify(payload));return;
  }
  const target=url.pathname.startsWith('/assets/')?path.resolve(root,'.'+url.pathname):path.join(root,'index.html');
  if(!target.startsWith(root+path.sep)){res.writeHead(404);res.end();return;}
  try{let file=await fs.readFile(target);const ext=path.extname(target);res.setHeader('Content-Type',ext==='.js'?'text/javascript':ext==='.css'?'text/css':'text/html');if(ext==='.html')file=Buffer.from(file.toString().replace('<body>','<body><div style="background:#4c2866;color:white;padding:8px;text-align:center;font:12px sans-serif">PRÉVIA LOCAL · DADOS SIMULADOS · NENHUMA CONTA REAL</div>'));res.end(file);}catch{res.writeHead(404);res.end();}
});
server.listen(4174,'127.0.0.1',()=>console.log('QA isolado: http://127.0.0.1:4174/?scenario=four#/analytics'));
