import type { AppContext } from '../context.js';
import { form } from '../lib/http.js';
import { analyticsToken, connectionIdentity, grantedScopes } from './auth.js';
import { absent, AnalyticsError, base, json, metric } from './common.js';
export async function collectTikTok(ctx:AppContext,start:string,end:string) {
  const token=await analyticsToken(ctx,'tiktok'), {id,name}=connectionIdentity(ctx,'tiktok');
  const scopes=grantedScopes(ctx,'tiktok'),stats=scopes.includes('user.info.stats');
  const p=await json(ctx,`https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url${stats?',follower_count,likes_count,video_count':''}`,token);
  const user=p.data?.user; if(user?.open_id !== id) throw new AnalyticsError('disconnected');
  const out=base(ctx,'tiktok',id!,user.display_name ?? name ?? id!,start,end);out.avatar=user.avatar_url;
  out.metrics.followers=metric(user.follower_count,'TikTok Display API · follower_count','current');
  out.metrics.likes=metric(user.likes_count,'TikTok Display API · likes_count','current',{definition:'Total atual de curtidas da conta; não é o total do período.'});
  if(!stats){out.metrics.followers=absent('permission','TikTok · user.info.stats','current');out.metrics.likes=absent('permission','TikTok · user.info.stats','current');}
  let cursor:number|undefined;
  for(let page=0;scopes.includes('video.list')&&page<10;page++) {
    const j=await json(ctx,`https://open.tiktokapis.com/v2/video/list/?${form({fields:'id,title,video_description,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count'})}`,token,{max_count:20,...(cursor?{cursor}:{})});
    for(const v of j.data?.videos ?? []) out.content.push({id:v.id,title:v.title ?? v.video_description ?? v.id,publishedAt:new Date(v.create_time*1000).toISOString(),thumbnail:v.cover_image_url,url:v.share_url,platform:'tiktok',basis:'lifetime',metrics:{views:metric(v.view_count,'TikTok · view_count','lifetime'),likes:metric(v.like_count,'TikTok · like_count','lifetime'),comments:metric(v.comment_count,'TikTok · comment_count','lifetime'),shares:metric(v.share_count,'TikTok · share_count','lifetime')}});
    if(!j.data?.has_more) break;
    if(!j.data.cursor || j.data.cursor === cursor) throw new AnalyticsError('temporary_error');
    cursor=j.data.cursor;
    if(page===9) out.notes.push('Amostra limitada aos 200 vídeos públicos mais recentes; paginação interrompida para respeitar o orçamento da coleta.');
  }
  if(!scopes.includes('video.list'))out.notes.push('Permissão video.list necessária para consultar os vídeos públicos.');
  for(const key of ['views','reach','watchHours','averageSeconds','retention','revenue'] as const) out.metrics[key]=absent('unavailable','TikTok Display API');
  out.notes.push('A Display API retorna contadores acumulados de vídeos públicos. O ranking usa os totais disponíveis, filtrando pela data de publicação. Seguidores: snapshots reais a partir da primeira coleta; não há histórico retroativo, horas assistidas ou receita nesta API.');
  return out;
}
