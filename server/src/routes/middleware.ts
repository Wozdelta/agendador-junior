import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { safeEqual } from '../lib/session.js';
import { linksFor, type Links } from '../lib/links.js';

/** Links (mídia/upload) adequados ao tipo de acesso desta requisição. */
export function linksOf(ctx: AppContext, res: Response): Links {
  return linksFor(ctx, ctx.current(), res.locals.access === 'remote' ? 'remote' : 'local');
}

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

function isLoopback(ip: string | undefined): boolean {
  return !!ip && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
}

export function allowedOrigins(ctx: AppContext): string[] {
  const p = ctx.config.port;
  const list = [ctx.config.webOrigin, `http://localhost:${p}`, `http://127.0.0.1:${p}`, 'http://localhost:5173', 'http://127.0.0.1:5173'];
  if (ctx.config.appUrl) list.push(ctx.config.appUrl);
  return list;
}

/**
 * Quem pode chegar ao backend:
 * - localhost (uso local): tudo;
 * - qualquer origem: links de mídia assinados (/public/media, /direct/*) e retornos OAuth;
 * - a Function de proxy da Vercel (cabeçalho x-agendador-proxy com o segredo): /api;
 * - o resto: 403.
 */
export function externalGuard(ctx: AppContext): RequestHandler {
  const publicHost = ctx.config.publicBaseUrl ? new URL(ctx.config.publicBaseUrl).host : null;
  return (req, res, next) => {
    const host = String(req.headers.host ?? '');
    const viaPublicHost = publicHost !== null && host === publicHost;
    const forwarded = !!req.headers['x-forwarded-for'] || !!req.headers['forwarded'];
    const viaProxy = req.headers['x-agendador-proxy'] !== undefined;
    const local = isLoopback(req.socket.remoteAddress) && !viaPublicHost && !forwarded && !viaProxy;
    if (local) {
      res.locals.access = 'local';
      return next();
    }
    if (req.method === 'GET' && (req.path.startsWith('/public/media/') || /^\/api\/oauth\/[a-z]+\/callback$/.test(req.path))) return next();
    if (req.path.startsWith('/direct/')) return next(); // token assinado validado na rota
    if (ctx.config.proxySecret && req.path.startsWith('/api/') && safeEqual(req.get('x-agendador-proxy'), ctx.config.proxySecret)) {
      res.locals.access = 'remote';
      return next();
    }
    res.status(403).json({ error: 'Acesso externo não permitido a esta rota.' });
  };
}

/** CORS só para as rotas /direct/* (upload e mídia assinados), liberado para APP_URL. */
export function directCors(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins(ctx).includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(origin && allowedOrigins(ctx).includes(origin) ? 204 : 403).end();
      return;
    }
    next();
  };
}

/** Bloqueia pedidos de escrita vindos de outras origens (CSRF). */
export function originGuard(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !allowedOrigins(ctx).includes(origin)) {
      res.status(403).json({ error: 'Origem não permitida.' });
      return;
    }
    next();
  };
}

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
};

/**
 * Chave de idempotência (cabeçalho Idempotency-Key): o mesmo pedido repetido
 * (clique duplo, nova tentativa do navegador) recebe a mesma resposta sem refazer a ação.
 */
export function idempotent(ctx: AppContext, scope: string): RequestHandler {
  return ah(async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new AppError(400, 'Idempotency-Key inválida.');
    const mc = ctx.current();
    const id = `${scope}:${req.params.id ?? ''}:${key}`;
    const nowIso = ctx.clock.now().toISOString();
    const existing = await mc.idem.mutate((d) => {
      // Limpeza de chaves com mais de 48 h
      const cutoff = ctx.clock.now().getTime() - 48 * 3600_000;
      for (let i = d.length - 1; i >= 0; i--) if (new Date(d[i].createdAt).getTime() < cutoff) d.splice(i, 1);
      const found = d.find((x) => x.id === id);
      if (!found) d.push({ id, status: 'pending', createdAt: nowIso });
      return found ?? null;
    });
    if (existing?.status === 'done') {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(existing.httpStatus ?? 200).json(existing.body);
      return;
    }
    if (existing?.status === 'pending') throw new AppError(409, 'Este pedido já está em andamento.', undefined, 'in_progress');

    const original = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      // Só respostas de sucesso são reaproveitadas; erros liberam a chave para o
      // usuário corrigir o formulário e tentar de novo.
      const finalize =
        status < 300
          ? mc.idem.update(id, (r) => {
              r.status = 'done';
              r.httpStatus = status;
              r.body = body;
            })
          : mc.idem.mutate((d) => {
              const i = d.findIndex((x) => x.id === id);
              if (i >= 0) d.splice(i, 1);
            });
      finalize.catch((e) => log.error('Falha ao gravar idempotência', e)).finally(() => original(body));
      return res;
    };
    next();
  });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  req.resume();
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON inválido.' });
    return;
  }
  log.error('Erro inesperado:', err?.stack ?? err);
  res.status(500).json({ error: 'Erro interno. Veja o log do servidor.' });
}
