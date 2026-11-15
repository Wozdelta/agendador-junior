import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import type { DataState, Metric, MetricKey, Metrics } from '../shared/analytics.js';
import { form } from '../lib/http.js';
import { analyticsToken, connectionIdentity, grantedScopes } from './auth.js';
import { absent, AnalyticsError, base, json, metric, number, optional, sum } from './common.js';

export async function collectMeta(ctx:AppContext,p:'facebook'|'instagram',start:string,end:string,includeContent=true) {
  const token=await analyticsToken(ctx,p), {id,name,page}=connectionIdentity(ctx,p), ig=p === 'instagram';
  const source=`Meta Graph ${ctx.config.meta.graphVersion} · ${ig ? 'Instagram Insights':'Page Insights'}`;
  const graph=`https://graph.facebook.com/${ctx.config.meta.graphVersion}`;
  const get=(object:string,edge:string,params:Record<string,any>={})=>json(ctx,`${graph}/${encodeURIComponent(object)}${edge}?${form(params)}`,token);
  const profile=await get(id!,'',{fields:ig ? 'id,username,followers_count,profile_picture_url':'id,name,followers_count,picture'});
  if(profile.id !== id) throw new AnalyticsError('disconnected');
  if(ig) {
    const linked=await get(page!.id,'',{fields:'instagram_business_account{id}'});
    if(linked.instagram_business_account?.id !== id) throw new AnalyticsError('disconnected');
  }
  const out=base(ctx,p,id!,ig&&profile.username?`@${profile.username}`:profile.name ?? name ?? id!,start,end);
  out.avatar=ig ? profile.profile_picture_url:profile.picture?.data?.url;
  out.metrics.followers=metric(profile.followers_count,`${source} · followers_count`,'current');
  const required=ig?'instagram_manage_insights':'read_insights';
  if(!grantedScopes(ctx,p).includes(required)) {
    for(const key of ['views','reach','interactions','revenue'] as const)out.metrics[key]=absent('permission',`${source} · ${required}`);
    out.notes.push(`Conceda ${required} para consultar Insights. A conexão de publicação foi preservada.`);return out;
  }
  const first=DateTime.fromISO(start,{zone:'UTC'}), last=DateTime.fromISO(end,{zone:'UTC'}).plus({days:1});
  const oldest=DateTime.fromJSDate(ctx.clock.now()).toUTC().minus({days:89}).startOf('day');
  const from=ig && first<oldest ? oldest:first;
  const rows=new Map<string,Metrics>();
  const definitions:Record<string,[MetricKey,string]> = ig ? {
    views:['views','Inícios e repetições de conteúdo no Instagram; não equivale a público único.'], reach:['reach','Contas únicas alcançadas em cada dia; os dias não são somados como alcance único do período.'], total_interactions:['interactions','Interações orgânicas informadas pelo Instagram.'],likes:['likes','Curtidas informadas no intervalo pelo Instagram.'],comments:['comments','Comentários informados no intervalo pelo Instagram.'],shares:['shares','Compartilhamentos informados no intervalo pelo Instagram.'],saves:['saves','Salvamentos informados no intervalo pelo Instagram.'],
  } : {
    page_media_view:['views','Vezes em que conteúdo da Página foi reproduzido ou exibido; inclui formatos além de vídeo.'], page_total_media_view_unique:['uniqueViewers','Pessoas únicas por dia; dias não são somados como público único do período.'], page_post_engagements:['interactions','Interações com as publicações da Página.'], page_daily_follows:['gained','Novos seguidores informados pela Página.'], page_daily_unfollows_unique:['lost','Pessoas que deixaram de seguir a Página.'],
  };
  for(const [remote,[key,definition]] of Object.entries(definitions)) {
    let failure:DataState|undefined;
    let accumulated:number|null=null,totalComplete=true;
    // Instagram account requests are chunked at 30 days; retain individual daily values.
    for(let cursor=from;cursor<last;cursor=cursor.plus({days:30})) {
      const until=cursor.plus({days:30})<last ? cursor.plus({days:30}):last;
      let chunkTotal:number|null=null;
      await optional(async()=>{
        const response=await get(id!,'/insights',{metric:remote,period:'day',since:Math.floor(cursor.toSeconds()),until:Math.floor(until.toSeconds()),...(ig && remote!=='reach'?{metric_type:'time_series'}:{})});
        for(const entry of response.data ?? []) for(const v of entry.values ?? []) {
          // end_time is the exclusive endpoint of a daily bucket, not the start date.
          const date=DateTime.fromISO(v.end_time,{zone:'UTC'}).minus({days:1}).toISODate();
          if(!date || date<start || date>end) continue;
          rows.set(date,{...rows.get(date),[key]:metric(v.value,`${source} · ${remote}`,'period',{definition})});
          const value=number(v.value);if(value!==null)chunkTotal=(chunkTotal??0)+value;
        }
        return true;
      },state=>{failure=state; return false;});
      if(ig&&key!=='reach'&&chunkTotal===null) await optional(async()=>{
        const response=await get(id!,'/insights',{metric:remote,period:'day',metric_type:'total_value',since:Math.floor(cursor.toSeconds()),until:Math.floor(until.toSeconds())});
        chunkTotal=number(response.data?.[0]?.total_value?.value);return true;
      },state=>{failure=state;return false;});
      if(ig&&key!=='reach'){if(chunkTotal!==null)accumulated=(accumulated??0)+chunkTotal;else totalComplete=false;}
    }
    const daily=[...rows.values()];
    const total=key==='reach'||key==='uniqueViewers' ? null:ig?accumulated:sum(daily,key);
    out.metrics[key]=total === null ? absent(failure ?? 'no_data',`${source} · ${remote}`):metric(total,`${source} · ${remote}`,'period',{definition});
    const covered=[...rows].filter(([,m])=>m[key]?.value!=null).map(([d])=>d).sort();
    out.metrics[key]={...out.metrics[key]!,complete:ig&&key!=='reach'?totalComplete&&from.toISODate()===start:covered.length===Math.round(last.diff(first,'days').days),coverageStart:covered[0]??(accumulated!==null?from.toISODate()!:undefined),coverageEnd:covered.at(-1)??(accumulated!==null?end:undefined)};
  }
  out.daily=[...rows].sort(([a],[b])=>a.localeCompare(b)).map(([date,metrics])=>({date,metrics}));
  if(ig && last.diff(first,'days').days<=30) {
    out.metrics.reach=await optional(async()=>{
      const r=await get(id!,'/insights',{metric:'reach',period:'day',metric_type:'total_value',since:Math.floor(first.toSeconds()),until:Math.floor(last.toSeconds())});
      return metric(r.data?.[0]?.total_value?.value,`${source} · reach total_value`,'period',{definition:'Contas únicas alcançadas no intervalo, conforme a API; não somado entre redes.'});
    },state=>absent(state,source));
  }
  if(out.metrics.gained?.value != null && out.metrics.lost?.value != null) out.metrics.net=metric(out.metrics.gained.value-out.metrics.lost.value,source);
  if(ig) {
    let gained:number|null=null,lost:number|null=null,complete=true;
    for(let cursor=from;cursor<last;cursor=cursor.plus({days:30})) {
      const until=cursor.plus({days:30})<last?cursor.plus({days:30}):last;
      let a:number|null=null,b:number|null=null;
      await optional(async()=>{
        const r=await get(id!,'/insights',{metric:'follows_and_unfollows',period:'day',metric_type:'total_value',breakdown:'follow_type',since:Math.floor(cursor.toSeconds()),until:Math.floor(until.toSeconds())});
        for(const group of r.data?.[0]?.total_value?.breakdowns??[]) for(const item of group.results??[]) {
          const type=String(item.dimension_values?.[0]??'').toUpperCase();
          if(type==='FOLLOW'||type==='FOLLOWS')a=number(item.value);
          if(type==='UNFOLLOW'||type==='UNFOLLOWS')b=number(item.value);
        }
        return true;
      },state=>{out.metrics.gained=absent(state,`${source} · follows_and_unfollows`);out.metrics.lost=absent(state,`${source} · follows_and_unfollows`);return false;});
      if(a!==null)gained=(gained??0)+a;if(b!==null)lost=(lost??0)+b;if(a===null||b===null)complete=false;
    }
    if(gained!==null)out.metrics.gained=metric(gained,`${source} · follows_and_unfollows`,'period',{complete:complete&&from.toISODate()===start});
    if(lost!==null)out.metrics.lost=metric(lost,`${source} · follows_and_unfollows`,'period',{complete:complete&&from.toISODate()===start});
    if(gained!==null&&lost!==null)out.metrics.net=metric(gained-lost,`${source} · follows_and_unfollows`,'period',{complete:complete&&from.toISODate()===start});
  }
  out.coverageStart=out.daily[0]?.date;out.coverageEnd=out.daily.at(-1)?.date;
  out.complete=out.coverageStart===start && out.coverageEnd===end && out.daily.length===Math.round(last.diff(first,'days').days);
  const content:any[]=[];let after:string|undefined;
  if(includeContent) await optional(async()=>{
    for(let n=0;n<4;n++) {
      const r=await get(id!,ig?'/media':'/videos',{fields:ig?'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count':'id,title,description,created_time,permalink_url,picture',limit:25,after});
      content.push(...(r.data ?? []));after=r.paging?.cursors?.after;
      if(!r.paging?.next || !after) break;
      if(n===3) out.notes.push('Ranking limitado aos 100 conteúdos mais recentes; os restantes não foram coletados nesta execução.');
    }
    return true;
  },state=>{out.notes.push(`Listagem de conteúdo: ${state}.`);return false;});
  // Bound per-content calls to 20 media. Other collected items retain real public counters.
  for(let i=0;i<content.length;i+=4) await Promise.all(content.slice(i,i+4).map(async(v,index)=>{
    const measures:Metrics=ig?{likes:metric(v.like_count,source,'lifetime'),comments:metric(v.comments_count,source,'lifetime')}:{};
    const definitions:Record<string,[MetricKey,number]> = ig ? {views:['views',1],reach:['reach',1],shares:['shares',1],saved:['saves',1],total_interactions:['interactions',1],...(v.media_product_type==='REELS'?{ig_reels_video_view_total_time:['watchHours',3600000] as [MetricKey,number],ig_reels_avg_watch_time:['averageSeconds',1000] as [MetricKey,number]}:{})} : {total_video_views:['views',1],total_video_view_total_time:['watchHours',3600000],total_video_avg_time_watched:['averageSeconds',1000]};
    if(i+index<20) for(const [remote,[key,divisor]] of Object.entries(definitions)) measures[key]=await optional(async()=>{
      const r=await get(v.id,ig?'/insights':'/video_insights',{metric:remote});
      const value=number(r.data?.[0]?.values?.[0]?.value ?? r.data?.[0]?.total_value?.value);
      return metric(value === null ? null:value/divisor,`${source} · ${remote}`,'lifetime');
    },state=>absent(state,`${source} · ${remote}`,'lifetime'));
    if(!ig&&i+index<20) await optional(async()=>{
      const r=await get(v.id,'/video_insights',{metric:'total_video_stories_by_action_type'});
      const actions=r.data?.[0]?.values?.[0]?.value;
      if(actions&&typeof actions==='object') for(const [action,value] of Object.entries(actions)) {
        const key=({like:'likes',comment:'comments',share:'shares'} as const)[action.toLowerCase() as 'like'|'comment'|'share'];
        if(key)measures[key]=metric(value,`${source} · total_video_stories_by_action_type · ${action}`,'lifetime');
      }
      return true;
    },()=>false);
    out.content.push({id:v.id,title:v.title ?? v.caption ?? v.description ?? v.id,url:v.permalink ?? v.permalink_url ?? `https://www.facebook.com/${encodeURIComponent(v.id)}`,thumbnail:v.thumbnail_url ?? (v.media_type==='IMAGE'?v.media_url:undefined) ?? v.picture,publishedAt:v.timestamp ?? v.created_time,platform:p,type:v.media_product_type ?? v.media_type,basis:'lifetime',metrics:measures});
  }));
  out.metrics.revenue=absent('unavailable',source);
  if(!ig) out.metrics.revenue=await optional(async()=>{
    const r=await get(id!,'/insights',{metric:'page_daily_video_ad_break_earnings_by_crosspost_status',period:'day',since:Math.floor(first.toSeconds()),until:Math.floor(last.toSeconds())});
    const values=(r.data?.[0]?.values ?? []).map((v:any)=>v.value);
    // A raw breakdown without explicit amount/currency is not a safe monetary value.
    const valid=values.filter((v:any)=>number(v?.amount)!==null && /^[A-Z]{3}$/.test(v?.currency));
    if(valid.length!==values.length || !valid.length || new Set(valid.map((v:any)=>v.currency)).size!==1) return absent('unavailable',source);
    return metric(valid.reduce((a:number,v:any)=>a+Number(v.amount),0),`${source} · ad_break_earnings`,'period',{currency:valid[0].currency,complete:false,definition:'Estimativa retornada com moeda explícita pela API. Não confirma pagamento; a cobertura monetária não foi confirmada para comparação.'});
  },state=>absent(state,source));
  out.notes.push('Métricas por conteúdo são acumuladas, não ganhos do período. Insights detalhados são consultados para até 20 conteúdos por coleta; limites e métricas rejeitadas não viram zeros.');
  if(ig) out.notes.push('Histórico da conta limitado aos últimos 90 dias. Alcance único não é obtido somando dias. Monetização não é fornecida por esta integração.');
  if(!ig && !grantedScopes(ctx,p).includes('pages_manage_engagement')) out.notes.push('Insights de vídeo podem exigir pages_manage_engagement e a tarefa ANALYZE; solicite apenas se a Meta exigir para sua Página.');
  return out;
}
