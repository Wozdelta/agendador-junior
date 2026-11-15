import { Router } from 'express';
import type { AppContext } from '../context.js';
import { toBatchDTO } from '../domain/batches.js';
import { AppError } from '../lib/errors.js';
import { linksFor, readDirectToken } from '../lib/links.js';
import { receiveCover, receiveVideo } from './batches.js';
import { ah } from './middleware.js';

/**
 * Rotas com link assinado e temporário, chamadas pelo navegador direto no
 * backend (PUBLIC_BASE_URL): upload de vídeo/capa e prévia/download de mídia.
 */
export function directRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/direct/media/:token', ah(async (req, res) => {
    const g = readDirectToken(ctx, String(req.params.token));
    if (!g || g.type !== 'media') throw new AppError(403, 'Link expirado ou inválido. Recarregue a página.');
    const mc = ctx.modes[g.mode];
    const m = mc.media.get(g.mediaId);
    if (!m) throw new AppError(404, 'Arquivo não encontrado.');
    if (req.query.download) res.attachment(m.originalName);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(m.mime);
    res.sendFile(m.internalName, { root: mc.mediaDir, dotfiles: 'deny' });
  }));

  r.put('/direct/upload/:token', ah(async (req, res) => {
    const g = readDirectToken(ctx, String(req.params.token));
    if (!g || g.type !== 'upload') throw new AppError(403, 'Link de envio expirado ou inválido. Recarregue a página.');
    const mc = ctx.modes[g.mode];
    const b =
      g.kind === 'video'
        ? await receiveVideo(ctx, mc, g.batchId, g.itemId, req)
        : await receiveCover(ctx, mc, g.batchId, g.itemId, req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(toBatchDTO(mc, b, linksFor(ctx, mc, 'remote')));
  }));
  return r;
}
