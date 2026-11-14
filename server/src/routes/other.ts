import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { cancelTask, editTask, manualComplete, rescheduleTask, resolveReview, retryTask, toTaskDTO } from '../domain/tasks.js';
import { AppError } from '../lib/errors.js';
import { pkcePair, verifyMediaToken } from '../lib/crypto.js';
import { log } from '../lib/log.js';
import { formatLocal } from '../lib/time.js';
import { adapterFor } from '../platforms/index.js';
import { metaAuthUrl, metaExchange } from '../platforms/meta.js';
import { TikTokAdapter, tiktokAuthUrl, tiktokExchange } from '../platforms/tiktok.js';
import { youtubeAuthUrl, youtubeExchange } from '../platforms/youtube.js';
import { PLATFORMS, type AppMode, type Platform, type SettingsDTO } from '../shared/types.js';
import { ah, allowedOrigins, idempotent, linksOf } from './middleware.js';

export function taskRoutes(ctx: AppContext): Router {
  const r = Router();
  const mcOf = () => ctx.current();

  r.get('/tasks', ah(async (_req, res) => {
    const mc = mcOf();
    const tasks = mc.tasks.all().sort((a, b) => a.plannedAt.localeCompare(b.plannedAt) || a.platform.localeCompare(b.platform));
    // Itens de rascunho aparecem na agenda como "Rascunho"
    const drafts = mc.batches
      .find((b) => b.status === 'draft')
      .flatMap((b) =>
        b.items.map((it) => ({
          batchId: b.id,
          itemId: it.id,
          originalName: it.originalName,
          plannedAt: it.scheduledAt,
          plannedLocal: formatLocal(it.scheduledAt, b.timezone),
          platforms: PLATFORMS.filter((p) => b.platforms[p] && it.platforms[p].enabled),
        })),
      );
    res.json({ tasks: tasks.map((t) => toTaskDTO(ctx, mc, t, linksOf(ctx, res))), drafts });
  }));

  const action = (name: string, fn: (id: string, body: any) => Promise<any>) =>
    r.post(`/tasks/:id/${name}`, idempotent(ctx, `task-${name}`), ah(async (req, res) => {
      const t = await fn(String(req.params.id), req.body ?? {});
      res.json(toTaskDTO(ctx, mcOf(), t, linksOf(ctx, res)));
    }));

  action('cancel', (id) => cancelTask(ctx, mcOf(), id));
  action('retry', (id) => retryTask(ctx, mcOf(), id));
  action('reschedule', (id, b) => rescheduleTask(ctx, mcOf(), id, b.date, b.time));
  action('manual-complete', (id, b) => manualComplete(ctx, mcOf(), id, b.url));
  action('resolve-review', (id, b) => resolveReview(ctx, mcOf(), id, b.outcome, b.url));
  r.patch('/tasks/:id', idempotent(ctx, 'task-edit'), ah(async (req, res) => {
    const t = await editTask(ctx, mcOf(), String(req.params.id), req.body ?? {});
    res.json(toTaskDTO(ctx, mcOf(), t, linksOf(ctx, res)));
  }));
  return r;
}

export function mediaRoutes(ctx: AppContext): Router {
  const r = Router();
  // Vídeos e capas ficam fora da pasta pública; servidos só para localhost.
  r.get('/media/:id', ah(async (req, res) => {
    const mc = ctx.current();
    const m = mc.media.get(String(req.params.id));
    if (!m) throw new AppError(404, 'Arquivo não encontrado.');
    if (req.query.download) res.attachment(m.originalName);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(m.mime);
    res.sendFile(m.internalName, { root: mc.mediaDir, dotfiles: 'deny' });
  }));
  return r;
}

/** Link temporário assinado: a Meta baixa UM arquivo específico durante a validade. */
export function publicRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/public/media/:token/:name', (req, res) => {
    const subject = verifyMediaToken(ctx.linkSecret, req.params.token, ctx.clock.now().getTime());
    const name = req.params.name;
    if (!subject || !/^[\w-]+(\.cover)?\.(mp4|mov|jpg|png)$/.test(name)) {
      res.status(404).end();
      return;
    }
    const [mode, internalName] = [subject.slice(0, subject.indexOf(':')), subject.slice(subject.indexOf(':') + 1)];
    if (internalName !== name || (mode !== 'real' && mode !== 'demo')) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(name, { root: ctx.modes[mode as AppMode].mediaDir, dotfiles: 'deny' });
  });
  return r;
}

export function settingsRoutes(ctx: AppContext): Router {
  const r = Router();
  const dto = (): SettingsDTO => {
    const tt = adapterFor(ctx, 'real', 'tiktok').account(ctx.modes.real).strategy;
    return {
      mode: ctx.settings.get().mode,
      timezone: ctx.config.timezone,
      publishTime: ctx.config.publishTime,
      lateToleranceMinutes: ctx.config.lateToleranceMinutes,
      minLeadMinutes: ctx.config.minLeadMinutes,
      publicBaseUrlConfigured: !!ctx.config.publicBaseUrl,
      tiktokMode: tt === 'inbox' || tt === 'direct' ? tt : 'manual',
      graphVersion: ctx.config.meta.graphVersion,
    };
  };
  r.get('/settings', (_req, res) => {
    res.json(dto());
  });
  r.post('/settings/mode', ah(async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'demo' && mode !== 'real') throw new AppError(400, 'Modo inválido.');
    if (req.body?.confirm !== true) throw new AppError(400, 'Confirme explicitamente a troca de modo.');
    await ctx.settings.mutate((s) => {
      s.mode = mode;
    });
    log.info(`Modo alterado para ${mode === 'demo' ? 'DEMONSTRAÇÃO' : 'REAL'}.`);
    res.json(dto());
  }));
  // Injeção de falhas: existe apenas no modo demonstração.
  r.post('/demo/faults', ah(async (req, res) => {
    if (ctx.settings.get().mode !== 'demo') throw new AppError(409, 'Disponível apenas no modo demonstração.');
    const { platform, kind, times } = req.body ?? {};
    if (!PLATFORMS.includes(platform)) throw new AppError(400, 'Plataforma inválida.');
    if (kind === null) {
      await ctx.modes.demo.demo.mutate((d) => {
        delete d.faults[platform];
      });
    } else {
      if (!['fail', 'transient', 'timeout', 'unverifiable'].includes(kind)) throw new AppError(400, 'Tipo de falha inválido.');
      await ctx.modes.demo.demo.mutate((d) => {
        d.faults[platform] = { kind, remaining: Math.max(1, Number(times) || 1) };
      });
    }
    res.json(ctx.modes.demo.demo.get().faults);
  }));
  return r;
}

export function connectionRoutes(ctx: AppContext): Router {
  const r = Router();
  const OAUTH_TTL = 10 * 60_000;

  r.get('/connections', ah(async (_req, res) => {
    const mc = ctx.current();
    res.json(await Promise.all(PLATFORMS.map((p) => adapterFor(ctx, mc.mode, p).connection(mc))));
  }));

  r.get('/connections/:platform/start', ah(async (req, res) => {
    if (ctx.settings.get().mode !== 'real') throw new AppError(409, 'Desative o modo demonstração para conectar contas reais.');
    const platform = String(req.params.platform) as Platform;
    if (!ctx.vault.available) throw new AppError(409, 'Defina TOKEN_ENCRYPTION_KEY no .env antes de conectar contas.');
    const ret = String(req.query.return ?? '');
    const returnTo = allowedOrigins(ctx).includes(ret) ? ret : ctx.config.webOrigin;
    const state = crypto.randomBytes(24).toString('base64url');
    // limpa estados vencidos
    for (const [k, v] of ctx.oauthStates) if (Date.now() - v.createdAt > OAUTH_TTL) ctx.oauthStates.delete(k);
    let url: string;
    if (platform === 'youtube') {
      if (!ctx.config.google.clientId) throw new AppError(409, 'Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env.');
      const { verifier, challenge } = pkcePair();
      ctx.oauthStates.set(state, { platform, verifier, createdAt: Date.now(), returnTo });
      url = youtubeAuthUrl(ctx, state, challenge);
    } else if (platform === 'facebook' || platform === 'instagram') {
      if (!ctx.config.meta.appId) throw new AppError(409, 'Configure META_APP_ID e META_APP_SECRET no .env.');
      ctx.oauthStates.set(state, { platform: 'facebook', createdAt: Date.now(), returnTo });
      url = metaAuthUrl(ctx, state);
    } else if (platform === 'tiktok') {
      if (!ctx.config.tiktok.clientKey || !ctx.config.tiktok.redirectUri) {
        throw new AppError(409, 'Configure TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET e TIKTOK_REDIRECT_URI (HTTPS) no .env.');
      }
      ctx.oauthStates.set(state, { platform, createdAt: Date.now(), returnTo });
      url = tiktokAuthUrl(ctx, state);
    } else throw new AppError(404, 'Plataforma desconhecida.');
    res.redirect(302, url);
  }));

  r.get('/oauth/:platform/callback', async (req, res) => {
    const platform = String(req.params.platform);
    const state = String(req.query.state ?? '');
    const pending = ctx.oauthStates.get(state);
    ctx.oauthStates.delete(state); // uso único
    const back = (q: string) => res.redirect(302, `${pending?.returnTo ?? ctx.config.webOrigin}/#/conexoes?${q}`);
    if (!pending || pending.platform !== platform || Date.now() - pending.createdAt > OAUTH_TTL) {
      res.status(400).send('Estado OAuth inválido ou expirado. Volte ao aplicativo e tente conectar novamente.');
      return;
    }
    if (req.query.error) return back(`erro=${encodeURIComponent(String(req.query.error_description ?? req.query.error))}`);
    const code = String(req.query.code ?? '');
    try {
      const mc = ctx.modes.real;
      if (platform === 'youtube') await youtubeExchange(ctx, mc, code, pending.verifier!);
      else if (platform === 'facebook') await metaExchange(ctx, mc, code);
      else if (platform === 'tiktok') await tiktokExchange(ctx, mc, code);
      back(`conectado=${platform}`);
    } catch (err: any) {
      log.error(`OAuth ${platform}:`, err.message);
      back(`erro=${encodeURIComponent(err.message)}`);
    }
  });

  r.post('/connections/facebook/page', ah(async (req, res) => {
    const pageId = String(req.body?.pageId ?? '');
    const mc = ctx.modes.real;
    await mc.connections.mutate((d) => {
      if (!d.facebook?.pages?.some((p) => p.id === pageId)) throw new AppError(400, 'Página não autorizada.');
      d.facebook.selectedPageId = pageId;
    });
    res.json(await adapterFor(ctx, 'real', 'facebook').connection(mc));
  }));

  r.post('/connections/:platform/disconnect', ah(async (req, res) => {
    const p = String(req.params.platform);
    const key = p === 'instagram' ? 'facebook' : p;
    if (!['youtube', 'facebook', 'tiktok'].includes(key)) throw new AppError(404, 'Plataforma desconhecida.');
    await ctx.modes.real.connections.mutate((d) => {
      delete (d as any)[key];
    });
    res.json({ ok: true });
  }));

  r.get('/connections/tiktok/creator-info', ah(async (_req, res) => {
    const mc = ctx.current();
    if (mc.mode === 'demo') {
      res.json({ privacy_level_options: ['SELF_ONLY'], creator_nickname: '[DEMO]', max_video_post_duration_sec: 600 });
      return;
    }
    const tt = new TikTokAdapter(ctx);
    if (tt.account(mc).strategy !== 'direct') throw new AppError(409, 'Direct Post não está habilitado para esta conexão.');
    const info = await tt.creatorInfo(mc);
    res.json({
      creator_nickname: info.creator_nickname,
      creator_username: info.creator_username,
      privacy_level_options: info.privacy_level_options,
      comment_disabled: info.comment_disabled,
      duet_disabled: info.duet_disabled,
      stitch_disabled: info.stitch_disabled,
      max_video_post_duration_sec: info.max_video_post_duration_sec,
    });
  }));
  return r;
}

export const webDist = (root: string) => path.join(root, 'web', 'dist');
