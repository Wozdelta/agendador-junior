import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { linksFor, type Links } from '../lib/links.js';
import { hasPersistence, requireOAuth, requirePersistence, requireMediaStorage } from '../lib/capabilities.js';

/** Carrega só o estado usado pela rota, sem bloquear telas por dependências alheias. */
export function prepareRequest(ctx: AppContext): RequestHandler {
  return ah(async (req, res, next) => {
    const p = req.path;
    if (p === '/settings' || p === '/health') return next();
    const oauth = p.startsWith('/oauth/') || /^\/connections\/[^/]+\/start$/.test(p);
    if (oauth) requireOAuth(ctx);
    if (p.startsWith('/storage/')) requireMediaStorage(ctx);
    if (ctx.config.runtime === 'vercel' && req.method !== 'GET' && /^\/(batches|tasks|connections|settings|demo|storage)(\/|$)/.test(p)) requirePersistence(ctx);
    if (!ctx.lazy) return next();
    if (!hasPersistence(ctx)) return next();
    try {
      if (ctx.config.runtime !== 'vercel') await ctx.settings.refresh();
      const mc = ctx.current();
      if (p.startsWith('/connections') || p.startsWith('/oauth/')) {
        await mc.connections.refresh();
        if (p.startsWith('/oauth/')) await ctx.oauthUsed.refresh();
      } else if (p === '/tasks' && req.method === 'GET') {
        await Promise.all([mc.batches.refresh(), mc.tasks.refresh(), mc.media.refresh()]);
      } else if (p.startsWith('/tasks') || p.startsWith('/batches') || p.startsWith('/storage') || p.startsWith('/media')) {
        await Promise.all([mc.batches.refresh(), mc.tasks.refresh(), mc.media.refresh(), mc.idem.refresh(), mc.connections.refresh(), mc.demo.refresh()]);
      }
    } catch {
      const message = 'O armazenamento do servidor está indisponível. Seus dados não foram apagados. Use a agenda manual ou tente de novo.';
      if (req.method === 'GET' && (p === '/connections' || p === '/tasks')) res.locals.storageWarning = message;
      else throw new AppError(503, message, undefined, 'storage_unavailable');
    }
    next();
  });
}

/** Links de mídia e upload privado no Supabase. */
export function linksOf(ctx: AppContext, _res?: Response): Links {
  return linksFor(ctx, ctx.current());
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
  if(ctx.config.runtime === 'vercel') return [ctx.config.webOrigin,ctx.config.appUrl].filter(Boolean);
  const list = [ctx.config.webOrigin, `http://localhost:${p}`, `http://127.0.0.1:${p}`, 'http://localhost:5173', 'http://127.0.0.1:5173'];
  if (ctx.config.appUrl) list.push(ctx.config.appUrl);
  return list;
}

/**
 * Quem pode chegar à API:
 * - na Vercel: rotas privadas de /api exigem Supabase Auth e administrador;
 *   escrita de outras origens é recusada (originGuard);
 * - no Node local: localhost; de fora, só links de mídia assinados (/public/media)
 *   e retornos OAuth (por exemplo, via túnel HTTPS).
 */
export function externalGuard(ctx: AppContext): RequestHandler {
  const publicHost = ctx.config.publicBaseUrl ? new URL(ctx.config.publicBaseUrl).host : null;
  return (req, res, next) => {
    if (ctx.config.runtime === 'vercel') return next();
    const host = String(req.headers.host ?? '');
    const viaPublicHost = publicHost !== null && host === publicHost;
    const forwarded = !!req.headers['x-forwarded-for'] || !!req.headers['forwarded'];
    if (isLoopback(req.socket.remoteAddress) && !viaPublicHost && !forwarded) return next();
    if (req.method === 'GET' && (req.path.startsWith('/public/media/') || /^\/api\/oauth\/[a-z]+\/callback$/.test(req.path))) return next();
    sendError(res, 403, 'Acesso externo não permitido a esta rota.', 'forbidden');
  };
}

/** Erro JSON padronizado: { error, code, details? }. */
export function sendError(res: Response, status: number, message: string, code: string, details?: unknown): void {
  res.status(status).json({ error: message, code, ...(details !== undefined ? { details } : {}) });
}

/** Bloqueia pedidos de escrita vindos de outras origens (CSRF). */
export function originGuard(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !allowedOrigins(ctx).includes(origin)) {
      sendError(res, 403, 'Origem não permitida.', 'origin_not_allowed');
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

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  415: 'unsupported_media',
  422: 'invalid',
  429: 'rate_limited',
  502: 'upstream_error',
  503: 'unavailable',
};

/** Toda resposta de erro da API é JSON: { error, code, details? } com o status HTTP correto. */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  req.resume();
  if (res.headersSent) return;
  if (err instanceof AppError) {
    sendError(res, err.status, err.message, err.code ?? CODE_BY_STATUS[err.status] ?? 'error', err.details);
    return;
  }
  if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'JSON inválido.', 'invalid_json');
  if (err?.type === 'entity.too.large') return sendError(res, 413, 'Corpo da requisição grande demais.', 'too_large');
  if (err?.name === 'ConflictError') return sendError(res, 409, err.message, 'conflict');
  log.error('Erro inesperado:', err?.stack ?? err);
  sendError(res, 500, 'Erro interno do servidor. Tente de novo em instantes.', 'internal_error');
}
