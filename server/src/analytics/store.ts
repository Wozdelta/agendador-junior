import path from 'node:path';
import type { AppContext } from '../context.js';
import type { Platform } from '../shared/types.js';
import { supabase } from '../lib/supabase.js';
import { FileBackend, JsonCollection } from '../lib/store.js';
import { AppError } from '../lib/errors.js';
export interface AnalyticsRecord { id:string; platform:Platform; account_id:string; kind:string; record_key:string; data:any; collected_at:string; }
export class AnalyticsStore {
  constructor(private ctx:AppContext) {}
  private async local() { return new JsonCollection<AnalyticsRecord>(new FileBackend(path.join(this.ctx.config.dataDir,`analytics-${this.ctx.ownerId}.json`))).load(); }
  async list():Promise<AnalyticsRecord[]> {
    if (!this.ctx.ownerId) throw new AppError(401,'Entre para continuar.');
    if (this.ctx.config.storage !== 'supabase') return (await this.local()).all();
    const rows:AnalyticsRecord[]=[];
    for(let offset=0;;offset+=1000) {
      const {data,error}=await supabase(this.ctx.config,true,this.ctx.fetch).from('analytics_records').select('platform,account_id,kind,record_key,data,collected_at').eq('owner_id',this.ctx.ownerId).neq('kind','lock').order('platform').order('account_id').order('kind').order('record_key').range(offset,offset+999);
      if(error) throw new AppError(503,'Analytics indisponível. Execute analytics.sql no Supabase e tente novamente.');
      rows.push(...(data??[]).map(r=>({...r,id:`${r.platform}:${r.account_id}:${r.kind}:${r.record_key}`})));
      if(!data || data.length<1000)break;
    }
    return rows;
  }
  async put(platform:Platform,account:string,kind:string,key:string,data:unknown,collectedAt=this.ctx.clock.now().toISOString()) {
    if (!this.ctx.ownerId) throw new AppError(401,'Entre para continuar.');
    if(this.ctx.config.storage === 'supabase') {
      const {error}=await supabase(this.ctx.config,true,this.ctx.fetch).rpc('analytics_put',{p_owner:this.ctx.ownerId,p_platform:platform,p_account:account,p_kind:kind,p_key:key,p_data:data,p_at:collectedAt});
      if(error) throw new AppError(503,'Não foi possível persistir Analytics. O último dado válido foi preservado.');
    } else {
      const c=await this.local(), id=`${platform}:${account}:${kind}:${key}`;
      await c.mutate(rows=>{ const i=rows.findIndex(r=>r.id===id); const row={id,platform,account_id:account,kind,record_key:key,data,collected_at:collectedAt}; if(i<0) rows.push(row); else if(rows[i].collected_at<=collectedAt) rows[i]=row; });
    }
  }
  async claim(p:Platform,account:string,key:string) {
    if(this.ctx.config.storage === 'supabase') {
      const {data,error}=await supabase(this.ctx.config,true,this.ctx.fetch).rpc('analytics_claim',{p_owner:this.ctx.ownerId,p_platform:p,p_account:account,p_key:key});
      if(error) throw new AppError(503,'Não foi possível iniciar a sincronização. Confira analytics.sql.');
      return data === true;
    }
    const c=await this.local(), id=`${p}:${account}:lock:${key}`,now=this.ctx.clock.now().getTime();
    return c.mutate(rows=>{ const found=rows.find(r=>r.id===id); if(found && found.data.until>now) return false; if(found) found.data.until=now+300_000; else rows.push({id,platform:p,account_id:account,kind:'lock',record_key:key,data:{until:now+300_000},collected_at:new Date(now).toISOString()}); return true; });
  }
}
