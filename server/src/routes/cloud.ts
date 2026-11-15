import crypto from 'node:crypto';
import { Router } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { head } from '@vercel/blob';
import type { AppContext } from '../context.js';
import type { MediaRecord } from '../domain/model.js';
import { requireDraft, mutateDraft, toBatchDTO } from '../domain/batches.js';
import { AppError } from '../lib/errors.js';
import { blobReader, isBlobUrl } from '../lib/mediaio.js';
import { probeImage, probeMp4 } from '../lib/mp4.js';
import { sniff } from '../lib/media.js';
import { requireMediaStorage } from '../lib/capabilities.js';
import { ah, linksOf } from './middleware.js';

export function cloudRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/blob', (_req, _res, next) => { try { requireMediaStorage(ctx); next(); } catch (err) { next(err); } });

  r.post('/blob/prepare', ah(async (req, res) => {
    if (ctx.config.mediaStorage !== 'blob') throw new AppError(409, 'Blob não configurado.');
    const { batchId, itemId, kind } = req.body ?? {};
    if (!['video', 'cover'].includes(kind)) throw new AppError(400, 'Tipo inválido.');
    const mc = ctx.current();
    const batch = requireDraft(mc.batches.get(batchId));
    if (!batch.items.some(i => i.id === itemId)) throw new AppError(404, 'Item não encontrado.');
    const ticket = crypto.randomUUID();
    const pathname = `${mc.mode}/${ticket}/${kind}`;
    await mc.idem.mutate(d => { d.push({ id: ticket, status: 'pending', createdAt: ctx.clock.now().toISOString(), body: { pathname, batchId, itemId, kind } }); });
    res.json({ ticket, pathname });
  }));
  r.post('/blob/token', ah(async (req, res) => {
    const result = await handleUpload({
      request: req, body: req.body as HandleUploadBody, token: ctx.config.blobToken,
      onBeforeGenerateToken: async (pathname, payload) => {
        const { ticket, mode } = JSON.parse(payload ?? '{}');
        if (mode !== ctx.current().mode) throw new AppError(400, 'Modo inválido.');
        const record = ctx.current().idem.get(ticket);
        const data = record?.body as any;
        if (!data || data.pathname !== pathname || Date.now() - Date.parse(record!.createdAt) > 3600_000) throw new AppError(403, 'Upload expirado.');
        requireDraft(ctx.current().batches.get(data.batchId));
        return {
          allowedContentTypes: data.kind === 'video' ? ['video/mp4', 'video/quicktime'] : ['image/jpeg'],
          maximumSizeInBytes: data.kind === 'video' ? ctx.config.maxVideoBytes : ctx.config.maxImageBytes,
          addRandomSuffix: false, allowOverwrite: false,
          tokenPayload: JSON.stringify({ ticket, mode }),
        };
      },
      // Completion is explicitly persisted by /complete, so browser retries are safe.
      onUploadCompleted: async () => {},
    });
    res.json(result);
  }));
  r.post('/blob/complete', ah(async (req, res) => {
    const mc = ctx.current();
    const { ticket, url } = req.body ?? {};
    const entry = mc.idem.get(ticket);
    const data = entry?.body as any;
    if (!data || !isBlobUrl(url)) throw new AppError(400, 'Upload inválido.');
    const batch = requireDraft(mc.batches.get(data.batchId));
    if (entry?.status === 'done') return res.json(toBatchDTO(mc, batch, linksOf(ctx)));
    const info = await head(url, { token: ctx.config.blobToken });
    if (info.pathname !== data.pathname) throw new AppError(403, 'Arquivo não pertence a este upload.');
    const max = data.kind === 'video' ? ctx.config.maxVideoBytes : ctx.config.maxImageBytes;
    if (!info.size || info.size > max) throw new AppError(413, 'Arquivo grande demais ou vazio.');
    const read = blobReader(ctx, url);
    const detected = sniff(await read(0, Math.min(64, info.size)));
    if (!detected || detected.kind !== (data.kind === 'video' ? 'video' : 'image') || (data.kind === 'cover' && detected.mime !== 'image/jpeg')) throw new AppError(415, 'Use MP4/MOV para vídeo e JPEG para capa.');
    let metadata;
    try { metadata = data.kind === 'video' ? await probeMp4(read, info.size) : await probeImage(read, info.size); }
    catch { throw new AppError(422, 'Arquivo incompleto ou metadados inválidos.'); }
    if ('hasVideo' in metadata && (!metadata.hasVideo || !('durationSec' in metadata) || Number(metadata.durationSec) <= 0)) throw new AppError(422, 'Vídeo inválido.');
    const rec: MediaRecord = {
      id: `midia_${ticket}`, kind: detected.kind, internalName: `${ticket}.${detected.ext}`,
      originalName: batch.items.find(i => i.id === data.itemId)?.originalName ?? 'capa.jpg',
      mime: detected.mime, size: info.size, blobUrl: url, ...metadata,
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
