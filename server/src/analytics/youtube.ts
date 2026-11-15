import type { AppContext } from '../context.js';
import type { Metrics, MetricKey } from '../shared/analytics.js';
import { analyticsToken, connectionIdentity, grantedScopes, MONETARY_SCOPE } from './auth.js';
import { absent, AnalyticsError, base, json, metric, number, optional } from './common.js';
import { form } from '../lib/http.js';
const SOURCE='YouTube Analytics API v2';
const MAP:Record<string,MetricKey>={views:'views',subscribersGained:'gained',subscribersLost:'lost',estimatedMinutesWatched:'watchHours',averageViewDuration:'averageSeconds',averageViewPercentage:'retention',likes:'likes',comments:'comments',shares:'shares',estimatedRevenue:'revenue'};
const METRICS='views,subscribersGained,subscribersLost,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares';
export function reportRows(j:any):Array<Record<string,any>> { return (j.rows ?? []).map((r:any[])=>Object.fromEntries((j.columnHeaders ?? []).map((h:any,i:number)=>[h.name,r[i]]))); }
function fields(row:Record<string,unknown>):Metrics {
  return Object.fromEntries(Object.entries(row).filter(([k])=>MAP[k]).map(([k,v])=>[MAP[k],metric(k === 'estimatedMinutesWatched' && number(v)!==null ? number(v)!/60:v,`${SOURCE} · ${k}`,'period',k === 'estimatedRevenue'?{currency:'USD'}:{})]));
}
export async function collectYouTube(ctx:AppContext,start:string,end:string,includeContent=true) {
  const token=await analyticsToken(ctx,'youtube'); const {id,name}=connectionIdentity(ctx,'youtube');
  const profile=await json(ctx,'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',token);
  const channel=profile.items?.find((x:any)=>x.id === id); if(!channel) throw new AnalyticsError('disconnected');
  const out=base(ctx,'youtube',id!,channel.snippet?.title ?? name ?? id!,start,end);
  out.avatar=channel.snippet?.thumbnails?.default?.url;
  out.metrics.followers=metric(channel.statistics?.hiddenSubscriberCount ? null:channel.statistics?.subscriberCount,'YouTube Data API v3 · subscriberCount','current',{definition:'Inscritos atuais; a API pode arredondar a contagem pública.'});
  if(!grantedScopes(ctx,'youtube').some(s=>s.endsWith('/yt-analytics.readonly')||s===MONETARY_SCOPE)) {
    for(const key of Object.values(MAP)) out.metrics[key]=absent('permission',SOURCE);
    out.notes.push('A publicação continua autorizada. Conceda a permissão de Analytics para obter os relatórios de desempenho.');return out;
  }
  const query=(params:Record<string,string|number>)=>json(ctx,`https://youtubeanalytics.googleapis.com/v2/reports?${form({ids:`channel==${id}`,startDate:start,endDate:end,...params})}`,token);
  const daily=await query({dimensions:'day',metrics:METRICS,sort:'day'});
  out.daily=reportRows(daily).map(row=>({date:row.day,metrics:fields(row)}));
  const total=await query({metrics:METRICS});
  const row=reportRows(total)[0]; if(row) out.metrics={...out.metrics,...fields(row)};
  if(out.metrics.gained?.value != null && out.metrics.lost?.value != null) out.metrics.net=metric(out.metrics.gained.value-out.metrics.lost.value,SOURCE);
  out.coverageStart=out.daily[0]?.date; out.coverageEnd=out.daily.at(-1)?.date;
  const expected=Math.round((Date.parse(end)-Date.parse(start))/86400_000)+1;
  out.complete=out.daily.length === expected && out.coverageStart === start && out.coverageEnd === end;
  if(includeContent) await optional(async()=>{
    const report=await query({dimensions:'video',metrics:'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares',sort:'-views',maxResults:200});
    const rows=reportRows(report), details=new Map<string,any>();
    for(let i=0;i<rows.length;i+=50) {
      const data=await json(ctx,`https://www.googleapis.com/youtube/v3/videos?${form({part:'snippet',id:rows.slice(i,i+50).map(r=>r.video).join(',')})}`,token);
      for(const v of data.items ?? []) details.set(v.id,v.snippet);
    }
    out.content=rows.map(r=>{const s=details.get(r.video);return {id:r.video,title:s?.title ?? r.video,url:`https://www.youtube.com/watch?v=${encodeURIComponent(r.video)}`,thumbnail:s?.thumbnails?.medium?.url,publishedAt:s?.publishedAt,platform:'youtube',basis:'period',metrics:fields(r)};});
    if(rows.length === 200) out.notes.push('Ranking limitado aos 200 principais vídeos disponibilizados pelo relatório.');
    return true;
  },state=>{out.notes.push(`Relatório por conteúdo: ${state}.`);return false;});
  if(includeContent) await optional(async()=>{ const split=await query({dimensions:'creatorContentType',metrics:'views,estimatedMinutesWatched'});out.contentTypes=reportRows(split).map(r=>({type:r.creatorContentType,metrics:fields(r)}));return true;},()=>false);
  if(grantedScopes(ctx,'youtube').includes(MONETARY_SCOPE)) {
    out.metrics.revenue=await optional(async()=>{
      const j=await query({metrics:'estimatedRevenue',currency:'USD'});
      const daily=reportRows(await query({dimensions:'day',metrics:'estimatedRevenue',currency:'USD',sort:'day'}));
      return metric(reportRows(j)[0]?.estimatedRevenue,`${SOURCE} · estimatedRevenue`,'period',{currency:'USD',definition:'Estimativa do relatório em USD; não confirma pagamento ou elegibilidade.',complete:daily.length===expected&&daily[0]?.day===start&&daily.at(-1)?.day===end,coverageStart:daily[0]?.day,coverageEnd:daily.at(-1)?.day});
    },state=>absent(state,SOURCE));
  } else out.metrics.revenue=absent('permission',`${SOURCE} · ${MONETARY_SCOPE}`);
  out.notes.push('Dias do YouTube seguem America/Los_Angeles e podem chegar com atraso. Horas assistidas no Analytics não são horas públicas válidas para monetização. Elegibilidade e pagamentos: consulte o Studio.');
  return out;
}
