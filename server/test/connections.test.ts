import express from 'express';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi, afterEach } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { TokenVault } from '../src/lib/crypto.js';
import { database, OWNER } from './supabase-fixture.js';
const APP='https://agendador-junior.vercel.app';
let fixture:Awaited<ReturnType<typeof database>>;
beforeAll(async()=>{fixture=await database();},30000);
afterAll(async()=>fixture?.db.close());
afterEach(()=>vi.unstubAllEnvs());
function config(overrides:Partial<Config>={}) {
 return loadConfig({runtime:'vercel',appUrl:APP,webOrigin:APP,storage:'supabase',mediaStorage:'disk',tokenKey:'',
  supabase:{url:'https://supabase.test',publishableKey:'test-public',secretKey:'server-secret-test-only'},
  google:{clientId:'google-id',clientSecret:'google-secret',redirectUri:`${APP}/api/oauth/youtube/callback`},
  meta:{appId:'meta-id',appSecret:'meta-secret',redirectUri:`${APP}/api/oauth/facebook/callback`,graphVersion:'v27.0',configId:'',reelsCustomCover:false,allowDirectPublishFallback:false,igResumable:false,igContainerLeadMinutes:60},
  tiktok:{clientKey:'tiktok-id',clientSecret:'tiktok-secret',redirectUri:`${APP}/api/oauth/tiktok/callback`,uploadApproved:false,directPostApproved:false,inboxLeadMinutes:30},...overrides});
}
const fakeFetch:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.hostname==='supabase.test') {
  const body=JSON.parse(String(init?.body));
  if(url.pathname.endsWith('/scheduler_load')) {
   const {rows}=await fixture.db.query('select scheduler_load($1,$2,$3) value',[body.p_owner,body.p_mode,body.p_name]);return Response.json((rows[0] as any).value);
  }
  if(url.pathname.endsWith('/scheduler_commit')) {
   const {rows}=await fixture.db.query('select scheduler_commit($1,$2,$3,$4,$5::jsonb) value',[body.p_owner,body.p_mode,body.p_name,body.p_expected,JSON.stringify(body.p_items)]);return Response.json((rows[0] as any).value);
  }
 }
 if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'google-access',refresh_token:'google-refresh',expires_in:3600});
 if(url.hostname==='www.googleapis.com'&&url.pathname.endsWith('/channels'))return Response.json({items:[{id:'channel',snippet:{title:'Canal teste'}}]});
 if(url.hostname==='graph.facebook.com') {
  if(url.pathname.endsWith('/oauth/access_token'))return Response.json({access_token:'meta-access'});
  if(url.pathname.endsWith('/me/permissions'))return Response.json({data:[{permission:'instagram_content_publish',status:'granted'}]});
  if(url.pathname.endsWith('/me/accounts'))return Response.json({data:[{id:'page',name:'Pagina teste',access_token:'page-secret',instagram_business_account:{id:'ig',username:'instagram_teste'}}]});
  if(url.pathname.endsWith('/me'))return Response.json({id:'facebook-user',name:'Conta teste'});
 }
 if(url.hostname==='open.tiktokapis.com') {
  if(url.pathname.endsWith('/oauth/token/'))return Response.json({access_token:'tiktok-access',refresh_token:'tiktok-refresh',open_id:'tiktok-user',scope:'user.info.basic',expires_in:7200});
  if(url.pathname.includes('/user/info/'))return Response.json({data:{user:{open_id:'tiktok-user',display_name:'TikTok teste'}},error:{code:'ok'}});
 }
 throw new Error(`Rota simulada inesperada: ${url.hostname}${url.pathname}`);
};
function api(configValue:Config) {
 const app=express();
 app.use(async(req,res,next)=>{
  try {const ctx=await createContext({config:configValue,fetchImpl:fakeFetch,lazy:true});createApp(ctx,(_req,_res,go)=>{ctx.ownerId=OWNER;go();})(req,res,next);}catch(e){next(e);}
 });return request(app);
}
describe('OAuth completo na Vercel com Supabase, sem chave extra nem Blob',()=>{
 it('deriva chave estavel sem expor segredo e preserva a chave dedicada anterior',()=>{
  const a=config(),b=config();expect(a.tokenKey).toBe(b.tokenKey);expect(a.tokenKey).not.toBe(a.supabase.secretKey);
  const encrypted=new TokenVault(a.tokenKey).encrypt({access_token:'private'},'youtube');
  expect(new TokenVault(b.tokenKey).decrypt(encrypted,'youtube')).toEqual({access_token:'private'});
  const previous=Buffer.alloc(32,8).toString('base64');expect(config({tokenKey:previous}).tokenKey).toBe(previous);
 });
 it('habilita as quatro redes e salva contas cifradas pelos callbacks em novas instancias',async()=>{
  const cfg=config(),client=api(cfg);
  const before=await client.get('/api/connections').expect(200);expect(before.body).toHaveLength(4);
  expect(before.body.every((c:any)=>c.canConnect&&c.blockers.length===0)).toBe(true);
  for(const platform of ['youtube','instagram','tiktok']) {
   const start=await client.post(`/api/connections/${platform}/start`).send({returnTo:APP}).expect(200);
   const url=new URL(start.body.url);expect(url.protocol).toBe('https:');
   expect(url.searchParams.get('redirect_uri')).toBe(`${APP}/api/oauth/${platform==='instagram'?'facebook':platform}/callback`);
   if(platform==='tiktok')expect(url.searchParams.get('scope')).toBe('user.info.basic');
   if(platform==='youtube'){expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('prompt')).toBe('select_account consent');}
   const callback=`/api/oauth/${platform==='instagram'?'facebook':platform}/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=test-code`;
   const result=await client.get(callback).expect(302);expect(result.headers.location).toContain('conectado=');if(platform==='instagram')expect(result.headers.location).toContain('origem=instagram');
   await client.get(callback).expect(400);
  }
  const after=await client.get('/api/connections').expect(200);expect(after.body.every((c:any)=>c.connected&&!c.needsReconnect)).toBe(true);
  expect(after.body.find((c:any)=>c.platform==='instagram').accountName).toBe('@instagram_teste');
  for(const secret of ['google-access','meta-access','page-secret','tiktok-access',cfg.supabase.secretKey,cfg.tokenKey])expect(JSON.stringify(after.body)).not.toContain(secret);
  const stored=(await fixture.db.query<{data:any}>("select data from scheduler_records where collection='connections' and owner_id=$1",[OWNER])).rows[0].data;
  expect(stored.youtube.tokensEnc).toMatch(/^v1:/);expect(stored.facebook.pages[0].tokenEnc).toMatch(/^v1:/);
  expect(new TokenVault(cfg.tokenKey).decrypt(stored.tiktok.tokensEnc,'tiktok')).toMatchObject({access_token:'tiktok-access'});
 });
 it('explica credencial ausente sem bloquear outra rede, rejeita callback local em producao e chave invalida',async()=>{
  const missing=config({google:{clientId:'id',clientSecret:'',redirectUri:`${APP}/api/oauth/youtube/callback`}});
  const response=await api(missing).get('/api/connections').expect(200);
  expect(response.body.find((c:any)=>c.platform==='youtube')).toMatchObject({canConnect:false});
  expect(response.body.find((c:any)=>c.platform==='youtube').blockers.join(' ')).toContain('GOOGLE_CLIENT_SECRET');
  expect(response.body.find((c:any)=>c.platform==='facebook').canConnect).toBe(true);
  const invalid=config({tokenKey:'invalid',google:{...missing.google,clientSecret:'secret',redirectUri:'http://localhost:3001/api/oauth/youtube/callback'}});
  const blocked=await api(invalid).get('/api/connections').expect(200);
  expect(blocked.body.find((c:any)=>c.platform==='youtube').blockers.join(' ')).toContain('GOOGLE_REDIRECT_URI');
  await api(invalid).post('/api/connections/facebook/start').send({}).expect(409);
 });
});
it('usa callbacks do dominio publicado quando a Vercel nao expoe a URL do projeto',()=>{
 for(const name of ['APP_URL','VERCEL_PROJECT_PRODUCTION_URL','GOOGLE_REDIRECT_URI','META_REDIRECT_URI','TIKTOK_REDIRECT_URI'])vi.stubEnv(name,'');
 vi.stubEnv('VERCEL','1');
 const cfg=loadConfig();expect(cfg.appUrl).toBe(APP);
 expect(cfg.google.redirectUri).toBe(`${APP}/api/oauth/youtube/callback`);
 expect(cfg.meta.redirectUri).toBe(`${APP}/api/oauth/facebook/callback`);
 expect(cfg.tiktok.redirectUri).toBe(`${APP}/api/oauth/tiktok/callback`);
});

it('cancelar ou retornar sem codigo preserva a autorizacao anterior',async()=>{
 const client=api(config());
 const stored=async()=>(await fixture.db.query<{data:any}>("select data from scheduler_records where collection='connections' and owner_id=$1",[OWNER])).rows[0]?.data;
 const before=await stored();
 for(const query of ['error=access_denied','']) {
  const start=await client.post('/api/connections/youtube/start').send({returnTo:APP}).expect(200);
  const state=new URL(start.body.url).searchParams.get('state')!;
  const result=await client.get(`/api/oauth/youtube/callback?state=${encodeURIComponent(state)}&${query}`).expect(302);
  expect(result.headers.location).toContain('erro=');if(query)expect(result.headers.location).toContain('cancelado');
  expect(await stored()).toEqual(before);
 }
});
