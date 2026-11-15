import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AppContext } from '../context.js';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../lib/errors.js';
import { ah } from './middleware.js';
export const normalizeEmail = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';
function allowed(ctx: AppContext, email: unknown) {
  const admin = normalizeEmail(ctx.config.adminEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin))
    throw new AppError(503, 'Configure Login_ADM no servidor.', undefined, 'auth_not_configured');
  if (normalizeEmail(email) !== admin)
    throw new AppError(
      403,
      'Este e-mail não tem acesso ao Agendador Junior.',
      undefined,
      'admin_only',
    );
}
function cookies(req: Request) {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim().split(/=(.*)/s).slice(0, 2))
      .filter((v) => v.length === 2),
  );
}
const cookieOptions = (ctx: AppContext) => ({
  httpOnly: true,
  secure: ctx.config.runtime === 'vercel',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 7 * 86400_000,
});
function clear(ctx: AppContext, res: Response) {
  for (const key of ['aj_access', 'aj_refresh', 'aj_session'])
    res.clearCookie(key, cookieOptions(ctx));
}
async function identity(ctx: AppContext, req: Request, res: Response) {
  const c = cookies(req);
  if (!c.aj_session || (!c.aj_access && !c.aj_refresh))
    throw new AppError(401, 'Entre para continuar.', undefined, 'unauthenticated');
  const client = supabase(ctx.config, false, ctx.fetch);
  let access = c.aj_access;
  let user = access ? (await client.auth.getUser(access)).data.user : null;
  if (!user && c.aj_refresh) {
    const { data, error } = await client.auth.refreshSession({ refresh_token: c.aj_refresh });
    if (!error && data.session) {
      access = data.session.access_token;
      user = (await client.auth.getUser(access)).data.user;
      res.cookie('aj_access', access, cookieOptions(ctx));
      res.cookie('aj_refresh', data.session.refresh_token, cookieOptions(ctx));
    }
  }
  if (!user || !user.email_confirmed_at) {
    clear(ctx, res);
    throw new AppError(401, 'Sua sessão expirou. Entre novamente.', undefined, 'unauthenticated');
  }
  allowed(ctx, user.email);
  // O segredo só é usado depois de provar a identidade e conferir Login_ADM.
  const db = supabase(ctx.config, true, ctx.fetch);
  const { data, error } = await db
    .from('scheduler_sessions')
    .select('id')
    .eq('id', c.aj_session)
    .eq('owner_id', user.id)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw new AppError(503, 'Não foi possível validar a sessão no banco. Tente de novo.');
  if (!data) {
    clear(ctx, res);
    throw new AppError(401, 'Sessão encerrada. Entre novamente.', undefined, 'unauthenticated');
  }
  ctx.ownerId = user.id;
  return {
    user: { id: user.id, email: normalizeEmail(user.email) },
    access,
    sessionId: c.aj_session,
  };
}
export const authenticate = (ctx: AppContext) =>
  ah(async (req, res, next) => {
    await identity(ctx, req, res);
    next();
  });
export function authRoutes(ctx: AppContext) {
  const r = Router();
  r.get(
    '/auth/session',
    ah(async (req, res) => {
      if (!cookies(req).aj_session) return res.json({ user: null });
      try {
        res.json({ user: (await identity(ctx, req, res)).user });
      } catch (e) {
        if (e instanceof AppError && e.status === 401) return res.json({ user: null });
        throw e;
      }
    }),
  );
  r.post(
    '/auth/login',
    ah(async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      allowed(ctx, email);
      const password = req.body?.password;
      if (typeof password !== 'string' || !password.length || password.length > 4096)
        throw new AppError(400, 'Informe sua senha.');
      const client = supabase(ctx.config, false, ctx.fetch);
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data.session)
        throw new AppError(
          error?.status === 429 ? 429 : 401,
          error?.status === 429
            ? 'Muitas tentativas. Aguarde um pouco e tente novamente.'
            : 'E-mail ou senha inválidos. Confira os dados e tente novamente.',
          undefined,
          'login_failed',
        );
      const { data: verified, error: verificationError } = await client.auth.getUser(
        data.session.access_token,
      );
      if (verificationError || !verified.user?.email_confirmed_at)
        throw new AppError(401, 'Não foi possível confirmar a identidade.');
      allowed(ctx, verified.user.email);
      const id = crypto.randomUUID();
      const { error: dbError } = await supabase(ctx.config, true, ctx.fetch)
        .from('scheduler_sessions')
        .insert({
          id,
          owner_id: verified.user.id,
          expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        });
      if (dbError)
        throw new AppError(
          503,
          'Execute supabase/setup.sql e confira a chave secreta antes de entrar.',
        );
      res.cookie('aj_access', data.session.access_token, cookieOptions(ctx));
      res.cookie('aj_refresh', data.session.refresh_token, cookieOptions(ctx));
      res.cookie('aj_session', id, cookieOptions(ctx));
      res.json({ user: { id: verified.user.id, email: normalizeEmail(verified.user.email) } });
    }),
  );
  r.post(
    '/auth/logout',
    ah(async (req, res) => {
      if (!cookies(req).aj_session) {
        clear(ctx, res);
        return res.json({ ok: true });
      }
      const session = await identity(ctx, req, res);
      const db = supabase(ctx.config, true, ctx.fetch);
      const { error } = await db
        .from('scheduler_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', session.sessionId)
        .eq('owner_id', session.user.id);
      if (error) throw new AppError(503, 'Não foi possível encerrar a sessão. Tente de novo.');
      await db.auth.admin.signOut(session.access, 'local');
      clear(ctx, res);
      res.json({ ok: true });
    }),
  );
  return r;
}
