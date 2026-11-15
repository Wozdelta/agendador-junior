import { Router } from 'express';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { ah } from './middleware.js';
import { AppError } from '../lib/errors.js';
import { supabase } from '../lib/supabase.js';
import { cloudPublicationQueue } from '../lib/publication-execution.js';
import { Worker } from '../queue/worker.js';

export async function processPublications(ctx:AppContext) {
  const worker=new Worker(ctx);
  await worker.recover();
  const end=Date.now()+Math.min(ctx.config.tickBudgetMs,220_000);
  let processed=0;
  for(let cycle=0;cycle<30&&Date.now()<end;cycle++) {
    const count=await worker.tick();processed+=count;if(!count)break;
  }
  return {processed};
}
export function publicationCron(ctx:AppContext) {
  const r=Router();
  r.get('/publication/cron',ah(async(req,res)=>{
    const secret=process.env.CRON_SECRET,actual=Buffer.from(req.get('authorization')??''),expected=Buffer.from(`Bearer ${secret}`);
    if(!secret||actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))throw new AppError(401,'Não autorizado.');
    if(!cloudPublicationQueue(ctx))throw new AppError(409,'O executor de publicação não está ativado. Configure PUBLICATION_SCHEDULER_ENABLED após configurar a chamada periódica.');
    const owner=process.env.SCHEDULER_OWNER_ID||process.env.ANALYTICS_OWNER_ID;
    if(!owner||!/^[0-9a-f-]{36}$/i.test(owner))throw new AppError(503,'Configure SCHEDULER_OWNER_ID ou ANALYTICS_OWNER_ID com o ID do administrador.');
    const {data,error}=await supabase(ctx.config,true,ctx.fetch).auth.admin.getUserById(owner);
    if(error||!ctx.config.adminEmail||data.user?.email?.trim().toLowerCase()!==ctx.config.adminEmail.trim().toLowerCase())throw new AppError(403,'Administrador inválido para executar a fila.');
    ctx.ownerId=owner;
    const result=await processPublications(ctx);
    res.json({ok:true,...result});
  }));
  return r;
}
