import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import type { AppContext, ModeContext } from '../context.js';
import {
  applyTexts,
  assertFuture,
  confirmBatch,
  createDraft,
  mutateDraft,
  newItem,
  parseStartDate,
  removeMediaFile,
  requireDraft,
  summarize,
  toBatchDTO,
} from '../domain/batches.js';
import type { Batch, MediaRecord } from '../domain/model.js';
import { toTaskDTO } from '../domain/tasks.js';
import { AppError } from '../lib/errors.js';
import { receiveFile } from '../lib/upload.js';
import { PLATFORMS } from '../shared/types.js';
import { ah, idempotent, linksOf } from './middleware.js';

export function batchRoutes(ctx: AppContext): Router {
  const r = Router();
  const mcOf = () => ctx.current();
  const get = (id: string) => {
    const b = mcOf().batches.get(id);
    if (!b) throw new AppError(404, 'Lote não encontrado.');
    return b;
  };

  r.get('/batches', ah(async (req, res) => {
    const mc = mcOf();
    const status = req.query.status;
    const list = mc.batches.find((b) => !status || b.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(list.map((b) => toBatchDTO(mc, b, linksOf(ctx, res))));
  }));

  r.post('/batches', idempotent(ctx, 'create-batch'), ah(async (req, res) => {
    const b = await createDraft(ctx, req.body?.startDate);
    res.status(201).json(toBatchDTO(mcOf(), b, linksOf(ctx, res)));
  }));

  r.get('/batches/:id', ah(async (req, res) => {
    res.json(toBatchDTO(mcOf(), get(String(req.params.id)), linksOf(ctx, res)));
  }));

  r.patch('/batches/:id', ah(async (req, res) => {
    const mc = mcOf();
    const body = req.body ?? {};
    const b = await mutateDraft(ctx, mc, String(req.params.id), (b) => {
      if (body.startDate !== undefined) {
        const iso = parseStartDate(body.startDate);
        assertFuture(ctx, { ...b, startDate: iso }, b.items.length);
        b.startDate = iso;
      }
      if (body.platforms) {
        for (const p of PLATFORMS) if (typeof body.platforms[p] === 'boolean') b.platforms[p] = body.platforms[p];
      }
    });
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

  r.delete('/batches/:id', ah(async (req, res) => {
    const mc = mcOf();
    const id = String(req.params.id);
    const b = await ctx.batchLocks.run(id, () =>
      mc.batches.mutate((d) => {
        const i = d.findIndex((x) => x.id === id);
        const found = requireDraft(d[i]);
        d.splice(i, 1);
        return found;
      }),
    );
    for (const it of b.items) {
      await removeMediaFile(mc, it.mediaId);
      await removeMediaFile(mc, it.coverId);
    }
    res.json({ ok: true });
  }));

  /** Reserva itens na ordem recebida pelo navegador, antes do envio dos arquivos. */
  r.post('/batches/:id/items', ah(async (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > 200) throw new AppError(400, 'Informe de 1 a 200 arquivos.');
    const mc = mcOf();
    const created: string[] = [];
    const b = await mutateDraft(ctx, mc, String(req.params.id), (b) => {
      assertFuture(ctx, b, b.items.length + files.length);
      for (const f of files) {
        const it = newItem(f?.name, f?.size);
        created.push(it.id);
        b.items.push(it);
      }
    });
    res.status(201).json({ batch: toBatchDTO(mc, b, linksOf(ctx, res)), itemIds: created });
  }));

    r.put('/batches/:id/items/:itemId/video', ah(async (req, res) => {
    const mc = mcOf();
    const b = await receiveVideo(ctx, mc, String(req.params.id), String(req.params.itemId), req);
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

  r.patch('/batches/:id/items/:itemId', ah(async (req, res) => {
    const mc = mcOf();
    const itemId = String(req.params.itemId);
    const body = req.body ?? {};
    const b = await mutateDraft(ctx, mc, String(req.params.id), (b) => {
      const it = b.items.find((i) => i.id === itemId);
      if (!it) throw new AppError(404, 'Vídeo não encontrado no lote.');
      if (body.platforms) applyTexts(it, body.platforms);
      if (body.coverFrameMs !== undefined) {
        const ms = Number(body.coverFrameMs);
        if (!Number.isInteger(ms) || ms < 0) throw new AppError(400, 'Quadro da capa inválido.');
        it.coverFrameMs = ms;
      }
    });
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

  r.delete('/batches/:id/items/:itemId', ah(async (req, res) => {
    const mc = mcOf();
    const itemId = String(req.params.itemId);
    let removed: { mediaId?: string; coverId?: string } = {};
    const b = await mutateDraft(ctx, mc, String(req.params.id), (b) => {
      const i = b.items.findIndex((x) => x.id === itemId);
      if (i < 0) throw new AppError(404, 'Vídeo não encontrado no lote.');
      removed = { mediaId: b.items[i].mediaId, coverId: b.items[i].coverId };
      b.items.splice(i, 1);
    });
    await removeMediaFile(mc, removed.mediaId);
    await removeMediaFile(mc, removed.coverId);
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

  r.put('/batches/:id/order', ah(async (req, res) => {
    const mc = mcOf();
    const ids: unknown = req.body?.itemIds;
    const b = await mutateDraft(ctx, mc, String(req.params.id), (b) => {
      if (!Array.isArray(ids) || ids.length !== b.items.length || new Set(ids).size !== ids.length) {
        throw new AppError(400, 'A nova ordem precisa conter todos os vídeos do lote, uma vez cada.');
      }
      const byId = new Map(b.items.map((i) => [i.id, i]));
      const next = ids.map((x) => byId.get(String(x)));
      if (next.some((x) => !x)) throw new AppError(400, 'A nova ordem contém vídeos desconhecidos.');
      b.items = next as typeof b.items; // cada item leva junto seus textos e capa
    });
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

    r.put('/batches/:id/items/:itemId/cover', ah(async (req, res) => {
    const mc = mcOf();
    const b = await receiveCover(ctx, mc, String(req.params.id), String(req.params.itemId), req);
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

  r.delete('/batches/:id/items/:itemId/cover', ah(async (req, res) => {
    const mc = mcOf();
    let previous: string | undefined;
    const b = await mutateDraft(ctx, mc, String(req.params.id), (b) => {
      const it = b.items.find((i) => i.id === String(req.params.itemId));
      if (!it) throw new AppError(404, 'Vídeo não encontrado no lote.');
      previous = it.coverId;
      it.coverId = undefined;
    });
    await removeMediaFile(mc, previous);
    res.json(toBatchDTO(mc, b, linksOf(ctx, res)));
  }));

  r.get('/batches/:id/summary', ah(async (req, res) => {
    const mc = mcOf();
    res.json(summarize(ctx, mc, get(String(req.params.id))));
  }));

  r.post('/batches/:id/confirm', idempotent(ctx, 'confirm'), ah(async (req, res) => {
    const mc = mcOf();
    const out = await confirmBatch(ctx, mc, String(req.params.id));
    res.status(out.alreadyConfirmed ? 200 : 201).json({
      batch: toBatchDTO(mc, out.batch, linksOf(ctx, res)),
      tasks: out.tasks.map((t) => toTaskDTO(ctx, mc, t, linksOf(ctx, res))),
      alreadyConfirmed: out.alreadyConfirmed,
    });
  }));

  return r;
}

/** Recebe o arquivo por streaming e anexa ao item do rascunho (usado também por /direct/upload). */
export async function receiveVideo(ctx: AppContext, mc: ModeContext, id: string, itemId: string, req: Request): Promise<Batch> {
    const b0 = requireDraft(mc.batches.get(id));
    if (!b0.items.some((i) => i.id === itemId)) throw new AppError(404, 'Vídeo não encontrado no lote.');
    await mutateDraft(ctx, mc, id, (b) => {
      const it = b.items.find((i) => i.id === itemId)!;
      it.uploadStatus = 'uploading';
      it.uploadError = undefined;
    });
    let rec: MediaRecord;
    try {
      const f = await receiveFile(req, { dir: mc.mediaDir, maxBytes: ctx.config.maxVideoBytes, kind: 'video' });
      const internalName = `${crypto.randomUUID()}.${f.ext}`;
      const finalPath = path.join(mc.mediaDir, internalName);
      await fs.rename(f.tmpPath, finalPath);
      let probe;
      try {
        probe = await ctx.prober(finalPath);
      } catch (err: any) {
        await fs.rm(finalPath, { force: true });
        throw new AppError(422, `Não foi possível ler o vídeo: ${err.message}`);
      }
      if (!probe.hasVideo || !(probe.durationSec > 0) || !/mov|mp4/.test(probe.formatName)) {
        await fs.rm(finalPath, { force: true });
        throw new AppError(422, 'O arquivo não é um vídeo MP4/MOV válido.');
      }
      rec = {
        id: `midia_${crypto.randomBytes(8).toString('hex')}`,
        kind: 'video',
        internalName,
        originalName: f.originalName.slice(0, 200),
        mime: f.mime,
        size: f.size,
        durationSec: Math.round(probe.durationSec * 100) / 100,
        width: probe.width,
        height: probe.height,
        videoCodec: probe.videoCodec,
        container: probe.formatName,
        createdAt: ctx.clock.now().toISOString(),
      };
      await mc.media.mutate((d) => {
        d.push(rec);
      });
    } catch (err: any) {
      await mutateDraft(ctx, mc, id, (b) => {
        const it = b.items.find((i) => i.id === itemId);
        if (it) {
          it.uploadStatus = 'error';
          it.uploadError = err.message;
        }
      }).catch(() => undefined);
      throw err;
    }
    let previous: string | undefined;
    let orphan = false;
    const b = await mutateDraft(ctx, mc, id, (b) => {
      const it = b.items.find((i) => i.id === itemId);
      if (!it) {
        orphan = true; // removido durante o envio
        return;
      }
      previous = it.mediaId;
      it.mediaId = rec.id;
      it.uploadStatus = 'ready';
      it.uploadError = undefined;
    });
    if (orphan) await removeMediaFile(mc, rec.id);
    if (previous && previous !== rec.id) await removeMediaFile(mc, previous);
    return b;
}

/** Recebe a imagem de capa por streaming (usado também por /direct/upload). */
export async function receiveCover(ctx: AppContext, mc: ModeContext, id: string, itemId: string, req: Request): Promise<Batch> {
    const b0 = requireDraft(mc.batches.get(id));
    if (!b0.items.some((i) => i.id === itemId)) throw new AppError(404, 'Vídeo não encontrado no lote.');
    const f = await receiveFile(req, { dir: mc.mediaDir, maxBytes: ctx.config.maxImageBytes, kind: 'image' });
    const internalName = `${crypto.randomUUID()}.${f.ext}`;
    const full = path.join(mc.mediaDir, internalName);
    await fs.rename(f.tmpPath, full);
    let width: number | undefined;
    let height: number | undefined;
    try {
      const p = await ctx.prober(full);
      width = p.width;
      height = p.height;
    } catch {
      await fs.rm(full, { force: true });
      throw new AppError(422, 'Não foi possível ler a imagem da capa.');
    }
    const rec: MediaRecord = {
      id: `midia_${crypto.randomBytes(8).toString('hex')}`,
      kind: 'image',
      internalName,
      originalName: f.originalName.slice(0, 200),
      mime: f.mime,
      size: f.size,
      width,
      height,
      createdAt: ctx.clock.now().toISOString(),
    };
    await mc.media.mutate((d) => {
      d.push(rec);
    });
    let previous: string | undefined;
    const b = await mutateDraft(ctx, mc, id, (b) => {
      const it = b.items.find((i) => i.id === itemId);
      if (!it) throw new AppError(404, 'Vídeo não encontrado no lote.');
      previous = it.coverId;
      it.coverId = rec.id;
    }).catch(async (err) => {
      await removeMediaFile(mc, rec.id);
      throw err;
    });
    if (previous) await removeMediaFile(mc, previous);
    return b;
}
