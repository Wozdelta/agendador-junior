import { Router } from 'express';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { PLATFORMS } from '../shared/types.js';
import { ah } from './middleware.js';
import { AppError } from '../lib/errors.js';
import { analyticsData, synchronize } from '../analytics/service.js';
import { range } from '../analytics/common.js';
import { supabase } from '../lib/supabase.js';

export function analyticsRoutes(ctx:AppContext) {
  const r=Router();
  const dates=(start:unknown,end:unknown)=>{try {
    if((start && !/^\d{4}-\d{2}-\d{2}$/.test(String(start))) || (end && !/^\d{4}-\d{2}-\d{2}$/.test(String(end)))) throw new Error();
    return range(start,end,ctx.clock.now());
  } catch {throw new AppError(400,'Escolha um intervalo de 1 a 90 dias completos, até ontem.');}};
  r.get('/analytics',ah(async(req,res)=>{await ctx.modes.real.connections.refresh();const {start,end}=dates(req.query.start,req.query.end);res.json(await analyticsData(ctx,start,end));}));
  r.post('/analytics/:platform/sync',ah(async(req,res)=>{
    const p=String(req.params.platform);if(!PLATFORMS.includes(p as any)) throw new AppError(404,'Plataforma desconhecida.');
    if(ctx.config.storage!=='supabase' && ctx.config.runtime==='vercel') throw new AppError(503,'Configure o Supabase para persistir Analytics.');
    await ctx.modes.real.connections.refresh();const {start,end}=dates(req.body?.start,req.body?.end);
    const result=await synchronize(ctx,p as any,start,end);res.json(result);
  }));
  return r;
}
export function analyticsCron(ctx:AppContext) {
  const r=Router();
  r.get('/analytics/cron',ah(async(req,res)=>{
    const secret=process.env.CRON_SECRET,header=Buffer.from(req.get('authorization') ?? '');
    const expected=Buffer.from(`Bearer ${secret}`);
    if(!secret || header.length!==expected.length || !crypto.timingSafeEqual(header,expected)) throw new AppError(401,'Não autorizado.');
    const owner=process.env.ANALYTICS_OWNER_ID;
    if(!owner || !/^[0-9a-f-]{36}$/i.test(owner)) throw new AppError(503,'Configure ANALYTICS_OWNER_ID com o ID do administrador no Supabase Auth.');
    const {data,error}=await supabase(ctx.config,true,ctx.fetch).auth.admin.getUserById(owner);
    if(error || data.user?.email?.trim().toLowerCase()!==ctx.config.adminEmail.trim().toLowerCase()) throw new AppError(403,'Administrador inválido para esta coleta.');
    ctx.ownerId=owner;await ctx.modes.real.connections.refresh();
    const {start,end}=range(undefined,undefined,ctx.clock.now());
    const results=await Promise.all(PLATFORMS.map(async p=>{try{return {platform:p,...await synchronize(ctx,p,start,end)};}catch{return {platform:p,state:'temporary_error'};}}));
    res.json({ok:true,results});
  }));
  return r;
}
