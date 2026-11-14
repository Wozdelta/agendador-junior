import { Router } from 'express';
import type { AppContext } from '../context.js';
import { toBatchDTO } from '../domain/batches.js';
import { AppError } from '../lib/errors.js';
import { linksFor, readDirectToken } from '../lib/links.js';
import { log } from '../lib/log.js';
import { SESSION_COOKIE, signSession, verifyPassword } from '../lib/session.js';
import type { SessionDTO } from '../shared/types.js';
import { receiveCover, receiveVideo } from './batches.js';
import { ah, isAuthenticated } from './middleware.js';

function clientIp(req: { headers: Record<string, any>; socket: { remoteAddress?: string } }): string {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

/** Login do acesso remoto (a interface na Vercel chega aqui pela Function de proxy). */
export function authRoutes(ctx: AppContext): Router {
  const r = Router();
  const configured = () => !!(ctx.config.appPasswordHash && ctx.sessionKey);

  r.get('/auth/session', (req, res) => {
    const remote = res.locals.access === 'remote';
    const body: SessionDTO = {
      loginRequired: remote,
      authenticated: !remote || isAuthenticated(ctx, req),
      loginConfigured: configured(),
      directLinks: !!ctx.config.publicBaseUrl,
    };
    res.json(body);
  });

  r.post('/auth/login', ah(async (req, res) => {
    if (res.locals.access !== 'remote') {
      res.json({ ok: true });
      return;
    }
    if (!configured()) throw new AppError(503, 'Login remoto não configurado no backend (APP_PASSWORD_HASH e TOKEN_ENCRYPTION_KEY).');
    const ip = clientIp(req);
    const now = ctx.clock.now().getTime();
    if (ctx.loginLimiter.blocked(ip, now)) throw new AppError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !verifyPassword(password, ctx.config.appPasswordHash)) {
      ctx.loginLimiter.fail(ip, now);
      log.warn(`Login remoto recusado (${ip}).`);
      throw new AppError(401, 'Senha incorreta.');
    }
    ctx.loginLimiter.reset(ip);
    const maxAge = ctx.config.sessionDays * 86400;
    const token = signSession(ctx.sessionKey!, now + maxAge * 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
    res.json({ ok: true });
  }));

  r.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });
  return r;
}

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
