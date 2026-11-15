import type { AppContext } from '../context.js';
import type { Platform } from '../shared/types.js';
import { request, form } from '../lib/http.js';
import { AnalyticsError, json } from './common.js';
import { YOUTUBE_SCOPES } from '../platforms/youtube.js';
import { META_SCOPES } from '../platforms/meta.js';

export const ANALYTICS_SCOPES: Record<Platform,string[]> = {
  youtube:['https://www.googleapis.com/auth/youtube.readonly','https://www.googleapis.com/auth/yt-analytics.readonly'],
  facebook:['read_insights','pages_read_engagement'],
  instagram:['instagram_basic','instagram_manage_insights','pages_read_engagement'],
  tiktok:['user.info.stats','video.list'],
};
export const MONETARY_SCOPE = 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';
export function connectionIdentity(ctx: AppContext, p: Platform) {
  const key = p === 'instagram' ? 'facebook' : p;
  const c = ctx.modes.real.connections.get()[key];
  const page = c?.pages?.find(x=>x.id === c.selectedPageId);
  return {key,c,page,id:p === 'facebook' ? page?.id : p === 'instagram' ? (c?.instagramDisconnected ? undefined : page?.instagram?.id) : c?.accountId,
    name:p === 'facebook' ? page?.name : p === 'instagram' ? (page?.instagram?.username?`@${page.instagram.username}`:undefined) : c?.accountName};
}
export function grantedScopes(ctx: AppContext,p: Platform) { const {c}=connectionIdentity(ctx,p); return c?.analyticsScopes ?? c?.scopes ?? []; }
export function missingScopes(ctx: AppContext,p: Platform) { const granted=grantedScopes(ctx,p); return ANALYTICS_SCOPES[p].filter(s=>!granted.includes(s) && !(s.endsWith('/youtube.readonly') && granted.includes('https://www.googleapis.com/auth/youtube')) && !(s.endsWith('/yt-analytics.readonly') && granted.includes(MONETARY_SCOPE))); }
export async function analyticsToken(ctx: AppContext,p: Platform): Promise<string> {
  const {c,key,page,id} = connectionIdentity(ctx,p);
  if (!c?.tokensEnc || !id) throw new AnalyticsError('disconnected');
  if (c.needsReconnect || c.analyticsNeedsReconnect) throw new AnalyticsError('expired');
  if (p === 'facebook' || p === 'instagram') {
    if(p==='instagram') {
      const user=ctx.vault.decrypt<any>((c.analyticsTokensEnc??c.tokensEnc)!,c.analyticsTokensEnc?'facebook-analytics':'facebook');
      if(user.expires_at&&user.expires_at<ctx.clock.now().getTime())throw new AnalyticsError('expired');
      return user.access_token;
    }
    const selected = c.analyticsPages?.find(x=>x.id === page?.id) ?? page;
    if (!selected?.tokenEnc) throw new AnalyticsError('permission');
    return ctx.vault.decrypt<string>(selected.tokenEnc, `facebook-page:${selected.id}`);
  }
  const dedicated = !!c.analyticsTokensEnc;
  const purpose = dedicated ? `${key}-analytics` : key;
  const t = ctx.vault.decrypt<any>((c.analyticsTokensEnc ?? c.tokensEnc)!,purpose);
  if (!t.expires_at || t.expires_at > ctx.clock.now().getTime()+60_000) return t.access_token;
  if (!t.refresh_token) throw new AnalyticsError('expired');
  const google = p === 'youtube';
  const r = await request(google ? 'https://oauth2.googleapis.com/token' : 'https://open.tiktokapis.com/v2/oauth/token/',{
    fetchImpl:ctx.fetch,method:'POST',timeoutMs:15_000,headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form(google ? {grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:ctx.config.google.clientId,client_secret:ctx.config.google.clientSecret} : {grant_type:'refresh_token',refresh_token:t.refresh_token,client_key:ctx.config.tiktok.clientKey,client_secret:ctx.config.tiktok.clientSecret}),
  });
  if (r.status === 429 || r.status >= 500) throw new AnalyticsError('temporary_error');
  if (!r.json?.access_token) throw new AnalyticsError('expired');
  const next={...t,...r.json,expires_at:ctx.clock.now().getTime()+r.json.expires_in*1000};
  await ctx.modes.real.connections.mutate(d=>{ d[key] = {...d[key], [dedicated ? 'analyticsTokensEnc':'tokensEnc']:ctx.vault.encrypt(next,purpose)}; });
  return next.access_token;
}

export function analyticsAuthUrl(ctx:AppContext,p:Platform,state:string,challenge?:string,monetary=false) {
  const {c}=connectionIdentity(ctx,p);
  // Analytics must not introduce publication scopes based only on configuration
  // flags. Keep existing grants so TikTok token rotation preserves publishing.
  const scopes = [...new Set([...(p === 'youtube' ? YOUTUBE_SCOPES : p === 'tiktok' ? ['user.info.basic'] : META_SCOPES),...(c?.scopes ?? []),...ANALYTICS_SCOPES[p],...(p === 'youtube' && monetary ? [MONETARY_SCOPE]:[])])];
  if (p === 'youtube') return `https://accounts.google.com/o/oauth2/v2/auth?${form({client_id:ctx.config.google.clientId,redirect_uri:ctx.config.google.redirectUri,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent',include_granted_scopes:true,state,code_challenge:challenge,code_challenge_method:'S256'})}`;
  if (p === 'tiktok') return `https://www.tiktok.com/v2/auth/authorize/?${form({client_key:ctx.config.tiktok.clientKey,redirect_uri:ctx.config.tiktok.redirectUri,response_type:'code',scope:scopes.join(','),state})}`;
  const configId = process.env.META_ANALYTICS_CONFIG_ID || ctx.config.meta.configId;
  return `https://www.facebook.com/${ctx.config.meta.graphVersion}/dialog/oauth?${form({client_id:ctx.config.meta.appId,redirect_uri:ctx.config.meta.redirectUri,response_type:'code',state,...(configId ? {config_id:configId}:{scope:scopes.join(',')})})}`;
}

export async function exchangeAnalytics(ctx:AppContext,p:Platform,code:string,verifier?:string) {
  const {c,key,id} = connectionIdentity(ctx,p);
  if (!c?.tokensEnc || !id) throw new AnalyticsError('disconnected');
  const google=p === 'youtube', tiktok=p === 'tiktok';
  const tokenUrl=google ? 'https://oauth2.googleapis.com/token':tiktok ? 'https://open.tiktokapis.com/v2/oauth/token/':`https://graph.facebook.com/${ctx.config.meta.graphVersion}/oauth/access_token`;
  const body=google ? {client_id:ctx.config.google.clientId,client_secret:ctx.config.google.clientSecret,redirect_uri:ctx.config.google.redirectUri,grant_type:'authorization_code',code,code_verifier:verifier} : tiktok ? {client_key:ctx.config.tiktok.clientKey,client_secret:ctx.config.tiktok.clientSecret,redirect_uri:ctx.config.tiktok.redirectUri,grant_type:'authorization_code',code} : {client_id:ctx.config.meta.appId,client_secret:ctx.config.meta.appSecret,redirect_uri:ctx.config.meta.redirectUri,code};
  const r=await request(tokenUrl,{fetchImpl:ctx.fetch,method:'POST',timeoutMs:15_000,headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form(body)});
  if (!r.json?.access_token) throw new AnalyticsError('permission');
  let t=r.json;
  if (!google && !tiktok) {
    const long=await request(tokenUrl+`?${form({grant_type:'fb_exchange_token',client_id:ctx.config.meta.appId,client_secret:ctx.config.meta.appSecret,fb_exchange_token:t.access_token})}`,{fetchImpl:ctx.fetch,timeoutMs:15_000});
    if (long.json?.access_token) t=long.json;
  }
  const token=t.access_token;
  let scopes:string[], pages:typeof c.pages;
  if (google) {
    const info=await json(ctx,'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',token);
    if (info.items?.[0]?.id !== c.accountId) throw new AnalyticsError('disconnected');
    scopes=String(t.scope ?? '').split(' ');
  } else if (tiktok) {
    if (t.open_id !== c.accountId) throw new AnalyticsError('disconnected');
    scopes=String(t.scope ?? '').split(',');
  } else {
    const graph=`https://graph.facebook.com/${ctx.config.meta.graphVersion}`;
    const user=await json(ctx,`${graph}/me?fields=id`,token);
    if (user.id !== c.accountId) throw new AnalyticsError('disconnected');
    const perms=await json(ctx,`${graph}/me/permissions`,token);
    scopes=(perms.data ?? []).filter((x:any)=>x.status === 'granted').map((x:any)=>x.permission);
    pages=[]; let after:string|undefined;
    for(let n=0;n<10;n++) {
      const response=await json(ctx,`${graph}/me/accounts?${form({fields:'id,name,access_token,instagram_business_account{id,username}',limit:100,after})}`,token);
      pages.push(...(response.data ?? []).map((x:any)=>({id:x.id,name:x.name,tokenEnc:ctx.vault.encrypt(x.access_token,`facebook-page:${x.id}`),instagram:x.instagram_business_account ? {id:x.instagram_business_account.id,username:x.instagram_business_account.username}:null})));
      after=response.paging?.cursors?.after; if(!response.paging?.next || !after) break;
      if(n === 9) throw new AnalyticsError('temporary_error');
    }
    if (!pages?.some(x=>x.id === c.selectedPageId && (p !== 'instagram' || x.instagram?.id === id))) throw new AnalyticsError('permission');
  }
  if (!ANALYTICS_SCOPES[p].some(s=>scopes.includes(s))) throw new AnalyticsError('permission');
  const previous=c.analyticsTokensEnc ? ctx.vault.decrypt<any>(c.analyticsTokensEnc,`${key}-analytics`):{};
  if ((google || tiktok) && !t.refresh_token && !previous.refresh_token) throw new AnalyticsError('permission');
  const saved={...previous,...t,expires_at:ctx.clock.now().getTime()+(t.expires_in ?? 3600)*1000};
  if(tiktok&&(c.scopes??[]).some(s=>!scopes.includes(s)))throw new AnalyticsError('permission');
  // TikTok rotates refresh tokens: publication and analytics must share one refreshed pair.
  await ctx.modes.real.connections.mutate(d=>{ d[key]={...d[key],
    ...(tiktok?{tokensEnc:ctx.vault.encrypt(saved,key),scopes,analyticsTokensEnc:undefined}: {analyticsTokensEnc:ctx.vault.encrypt(saved,`${key}-analytics`)}),
    analyticsScopes:scopes,analyticsPages:pages,analyticsNeedsReconnect:false}; });
}
