import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import { PLATFORMS, type Platform } from '../shared/types.js';
import type { AnalyticsDTO, AnalyticsPlatform, AnalyticsReport, Metrics, MetricKey } from '../shared/analytics.js';
import { connectionIdentity, missingScopes } from './auth.js';
import { absent, AnalyticsError, metric, range } from './common.js';
import { AnalyticsStore } from './store.js';
import { collectYouTube } from './youtube.js';
import { collectTikTok } from './tiktok.js';
import { collectMeta } from './meta.js';

export const collect = (ctx:AppContext,p:Platform,start:string,end:string,includeContent=true) => p === 'youtube' ? collectYouTube(ctx,start,end,includeContent) : p === 'tiktok' ? collectTikTok(ctx,start,end) : collectMeta(ctx,p,start,end,includeContent);
const reportKey=(start:string,end:string)=>`${start}:${end}`;
function preserve(old:AnalyticsReport|undefined,next:AnalyticsReport) {
  for(const [key,m] of Object.entries(next.metrics)) next.metrics[key as MetricKey]={...m,collectedAt:next.collectedAt};
  if(old) for(const [key,m] of Object.entries(old.metrics)) {
    if(next.metrics[key as MetricKey]?.value == null && m?.value != null) next.metrics[key as MetricKey]={...m,collectedAt:m.collectedAt ?? old.collectedAt,stale:true};
  }
  if(old) for(const content of next.content) {
    const before=old.content.find(c=>c.id===content.id);
    if(before) for(const [key,m] of Object.entries(before.metrics)) {
      const k=key as MetricKey;
      if(m?.value!=null&&content.metrics[k]?.value==null)content.metrics[k]={...m,collectedAt:m.collectedAt??old.collectedAt,stale:true};
    }
  }
  return next;
}
export async function synchronize(ctx:AppContext,p:Platform,start:string,end:string) {
  const r=range(start,end,ctx.clock.now()),store=new AnalyticsStore(ctx), {id,c,key}=connectionIdentity(ctx,p);
  if(!id || !c?.tokensEnc) return {state:'disconnected' as const};
  const rows=await store.list();
  const status=rows.find(x=>x.platform===p && x.account_id===id && x.kind==='status'&&x.record_key==='latest')?.data;
  if(status?.retryAt && status.retryAt>ctx.clock.now().toISOString()) return {state:'temporary_error' as const,retryAt:status.retryAt};
  const acquired=await store.claim(p,id,reportKey(start,end));
  if(!acquired) return {state:'temporary_error' as const,message:'Coleta recente ou em andamento. Aguarde até cinco minutos antes de repetir este período.'};
  let current:AnalyticsReport|undefined;
  try {
    current=await collect(ctx,p,start,end);
    const old=rows.find(x=>x.platform===p&&x.account_id===id&&x.kind==='report'&&x.record_key===reportKey(start,end))?.data as AnalyticsReport|undefined;
    current=preserve(old,current);
    await store.put(p,id,'report',reportKey(start,end),current,current.collectedAt);
    if(current.metrics.followers?.value != null && !current.metrics.followers.stale) {
      const day=DateTime.fromJSDate(ctx.clock.now()).setZone('America/Sao_Paulo').toISODate()!;
      await store.put(p,id,'snapshot',day,{date:day,value:current.metrics.followers.value,source:current.metrics.followers.source},current.collectedAt);
    }
    await ctx.modes.real.connections.mutate(d=>{if(d[key]) { d[key]!.analyticsVerifiedAt=current!.collectedAt; d[key]!.analyticsNeedsReconnect=false; }});
    let previous:AnalyticsReport|undefined;
    if(p!=='tiktok') {
      try {
        previous=await collect(ctx,p,r.previousStart,r.previousEnd,false);
        await store.put(p,id,'report',reportKey(r.previousStart,r.previousEnd),previous,previous.collectedAt);
      } catch { current.notes.push('O período anterior não pôde ser coletado; a coleta atual foi preservada.'); }
    }
    const values=Object.entries(current.metrics).filter(([key])=>key!=='revenue').map(([,m])=>m);
    const permissionBlocked=values.some(m=>m?.state==='permission')&&!values.some(m=>m?.basis==='period'&&m.value!=null&&!m.stale);
    const state=permissionBlocked?'permission' as const:'available' as const;
    await store.put(p,id,'status','latest',{state,lastAttempt:ctx.clock.now().toISOString(),lastSuccess:current.collectedAt});
    return {state};
  } catch(e) {
    const state=e instanceof AnalyticsError ? e.state:'temporary_error';
    if(state==='expired') await ctx.modes.real.connections.mutate(d=>{if(d[key]) {if(d[key]!.analyticsTokensEnc) d[key]!.analyticsNeedsReconnect=true;else d[key]!.needsReconnect=true;}});
    await store.put(p,id,'status','latest',{state,lastAttempt:ctx.clock.now().toISOString(),lastSuccess:current?.collectedAt ?? status?.lastSuccess,retryAt:e instanceof AnalyticsError ? e.retryAt:undefined});
    return {state};
  }
}

export async function analyticsData(ctx:AppContext,start:string,end:string):Promise<AnalyticsDTO> {
  const r=range(start,end,ctx.clock.now()),rows=await new AnalyticsStore(ctx).list();
  const platforms=PLATFORMS.map((p):AnalyticsPlatform=>{
    const {id,c,name}=connectionIdentity(ctx,p),scopes=missingScopes(ctx,p);
    const records=rows.filter(x=>x.platform===p&&x.account_id===id).sort((a,b)=>b.collected_at.localeCompare(a.collected_at));
    const status=records.find(x=>x.kind==='status'&&x.record_key==='latest')?.data;
    const reports=records.filter(x=>x.kind==='report');
    const latest=reports[0]?.data as AnalyticsReport|undefined;
    let report=reports.find(x=>x.record_key===reportKey(start,end))?.data as AnalyticsReport|undefined;
    if(!report && latest) report={...latest,start,end,metrics:{followers:latest.metrics.followers},daily:[],content:[],complete:false,coverageStart:undefined,coverageEnd:undefined,notes:['Este intervalo ainda não foi coletado. Use Atualizar dados.']};
    const snapshots=records.filter(x=>x.kind==='snapshot').map(x=>x.data).sort((a,b)=>a.date.localeCompare(b.date));
    if(report && !report.metrics.net) {
      const before=DateTime.fromISO(start).minus({days:1}).toISODate(),a=snapshots.find(s=>s.date===before),b=snapshots.find(s=>s.date===end);
      report={...report,metrics:{...report.metrics,net:a&&b ? metric(b.value-a.value,'Snapshots reais no Supabase','snapshot_delta',{definition:'Diferença entre snapshots nos limites do período; não representa novos seguidores brutos.'}):absent('no_data','Snapshots reais no Supabase','snapshot_delta')}};
    }
    return {platform:p,accountId:id,accountName:name,avatar:latest?.avatar,state:!c?.tokensEnc||!id ? 'disconnected' : c.needsReconnect||c.analyticsNeedsReconnect ? 'expired' : scopes.length ? 'permission' : status?.state ?? 'no_data',missingScopes:scopes,lastAttempt:status?.lastAttempt,lastSuccess:status?.lastSuccess,retryAt:status?.retryAt,report,
      previous:reports.find(x=>x.record_key===reportKey(r.previousStart,r.previousEnd))?.data,
      snapshots:snapshots.filter(s=>s.date>=start&&s.date<=end).map(s=>({date:s.date,value:s.value})),collectionStartedAt:snapshots[0]?.date};
  });
  return {start,end,platforms};
}

export function comparable(current:AnalyticsReport,previous:AnalyticsReport,key:MetricKey) {
  const a=current.metrics[key],b=previous.metrics[key];
  return current.complete && previous.complete && a?.basis==='period' && b?.basis==='period' && a.value!=null && b.value!=null && !a.stale && !b.stale && a.currency===b.currency;
}
