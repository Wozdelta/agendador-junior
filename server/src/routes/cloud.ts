import crypto from 'node:crypto';
import { Router } from 'express';
import { supabase, storageUrl, MEDIA_BUCKET } from '../lib/supabase.js';
import type { AppContext } from '../context.js';
import type { MediaRecord } from '../domain/model.js';
import { requireDraft, mutateDraft, toBatchDTO } from '../domain/batches.js';
import { AppError } from '../lib/errors.js';
import { remoteReader, remoteSize } from '../lib/mediaio.js';
import { probeImage, probeMp4 } from '../lib/mp4.js';
import { sniff } from '../lib/media.js';
import { requireMediaStorage } from '../lib/capabilities.js';
import { ah, linksOf } from './middleware.js';

export function cloudRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/storage', (_req, _res, next) => { try { requireMediaStorage(ctx); next(); } catch (err) { next(err); } });

  r.post('/storage/prepare', ah(async (req, res) => {
    if (ctx.config.mediaStorage !== 'supabase') throw new AppError(409, 'Supabase Storage não configurado.');
    const { batchId, itemId, kind } = req.body ?? {};
    if (!['video', 'cover'].includes(kind)) throw new AppError(400, 'Tipo inválido.');
    const mc = ctx.current();
    const batch = requireDraft(mc.batches.get(batchId));
    if (!batch.items.some(i => i.id === itemId)) throw new AppError(404, 'Item não encontrado.');
    const ticket = crypto.randomUUID();
    const pathname = `${ctx.ownerId}/${mc.mode}/${ticket}/${kind}`;
    await mc.idem.mutate(d => { d.push({ id: ticket, status: 'pending', createdAt: ctx.clock.now().toISOString(), body: { pathname, batchId, itemId, kind } }); });
    const { data: upload, error } = await supabase(ctx.config,true,ctx.fetch).storage.from(MEDIA_BUCKET).createSignedUploadUrl(pathname);
    if(error) throw new AppError(503,'Não foi possível preparar o upload. Confira o bucket privado agendador-media.');
    res.json({ ticket, url: upload.signedUrl });
  }));
  r.post('/storage/complete', ah(async (req, res) => {
    const mc = ctx.current();
    const { ticket } = req.body ?? {};
    const entry = mc.idem.get(ticket);
    const data = entry?.body as any;
    if (!data || Date.now()-Date.parse(entry!.createdAt)>3600_000) throw new AppError(400, 'Upload inválido.');
    const batch = requireDraft(mc.batches.get(data.batchId));
    if (entry?.status === 'done') return res.json(toBatchDTO(mc, batch, linksOf(ctx)));
    const url = await storageUrl(ctx.config,data.pathname,ctx.fetch);
    const info = { size: await remoteSize(ctx,url) };
    const max = data.kind === 'video' ? ctx.config.maxVideoBytes : ctx.config.maxImageBytes;
    if (!info.size || info.size > max) throw new AppError(413, 'Arquivo grande demais ou vazio.');
    const read = remoteReader(ctx, url);
    const detected = sniff(await read(0, Math.min(64, info.size)));
    if (!detected || detected.kind !== (data.kind === 'video' ? 'video' : 'image') || (data.kind === 'cover' && detected.mime !== 'image/jpeg')) throw new AppError(415, 'Use MP4/MOV para vídeo e JPEG para capa.');
    let metadata;
    try { metadata = data.kind === 'video' ? await probeMp4(read, info.size) : await probeImage(read, info.size); }
    catch { throw new AppError(422, 'Arquivo incompleto ou metadados inválidos.'); }
    if ('hasVideo' in metadata && (!metadata.hasVideo || !('durationSec' in metadata) || Number(metadata.durationSec) <= 0)) throw new AppError(422, 'Vídeo inválido.');
    const rec: MediaRecord = {
      id: `midia_${ticket}`, kind: detected.kind, internalName: `${ticket}.${detected.ext}`,
      originalName: batch.items.find(i => i.id === data.itemId)?.originalName ?? 'capa.jpg',
      mime: detected.mime, size: info.size, storagePath: data.pathname, ...metadata,
      createdAt: ctx.clock.now().toISOString(),
    };
    await mc.media.mutate(d => { if (!d.some(m => m.id === rec.id)) d.push(rec); });
    const updated = await mutateDraft(ctx, mc, batch.id, b => {
      const item = b.items.find(i => i.id === data.itemId);
      if (!item) throw new AppError(404, 'Item removido.');
      if (data.kind === 'video') { item.mediaId = rec.id; item.uploadStatus = 'ready'; item.uploadError = undefined; }
      else item.coverId = rec.id;
    });
    await mc.idem.update(ticket, x => { x.status = 'done'; });
    res.json(toBatchDTO(mc, updated, linksOf(ctx)));
  }));
  return r;
}
