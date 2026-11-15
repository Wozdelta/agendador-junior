import { storageUrl } from '../lib/supabase.js';
import { cloudPublicationQueue } from '../lib/publication-execution.js';
import { processPublications } from './publication.js';
import { analyticsAuthUrl, exchangeAnalytics, connectionIdentity, missingScopes, MONETARY_SCOPE, grantedScopes } from '../analytics/auth.js';
import { connectionBlockers } from '../lib/connection-readiness.js';
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
import { hasPersistence, hasMediaStorage, requireOAuth } from '../lib/capabilities.js';

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
    res.json({ tasks: tasks.map((t) => toTaskDTO(ctx, mc, t, linksOf(ctx, res))), drafts, warning: res.locals.storageWarning });
  }));

  r.post('/tasks/process-native', ah(async (_req, res) => {
    requireOAuth(ctx);
    await processPublications(ctx);
    res.json({ ok: true, message: cloudPublicationQueue(ctx)?'Ciclo concluído. A fila na nuvem processa as tarefas autorizadas; confira os resultados por plataforma.':'Ciclo concluído. Confira o status: apenas “Agendado na plataforma” confirma o agendamento nativo. O executor periódico de publicação ainda não está configurado.' });
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
    if (m.storagePath) return res.redirect(302,await storageUrl(ctx.config,m.storagePath,ctx.fetch));
    if (m.blobUrl) return res.redirect(302, m.blobUrl);
    if (ctx.config.runtime === 'vercel') throw new AppError(410, 'Este arquivo existia somente no disco local. Use o original para publicar manualmente.', undefined, 'media_unavailable');
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
  const dto = (remote: boolean): SettingsDTO => {
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
      remoteAccess: ctx.config.runtime === 'vercel' || remote,
      directLinks: ctx.config.mediaStorage === 'supabase' || !!ctx.config.publicBaseUrl,
      serverPersistence: hasPersistence(ctx),
      mediaPersistence: hasMediaStorage(ctx),
      oauthAvailable: hasPersistence(ctx) && ctx.vault.available,
      backgroundWorker: cloudPublicationQueue(ctx),
    };
  };
  r.get('/settings', (_req, res) => {
    res.json(dto(res.locals.access === 'remote'));
  });
  r.post('/settings/mode', ah(async (req, res) => {
    if (ctx.config.runtime === 'vercel') throw new AppError(409, 'A demonstração com fila é exclusiva da execução local. A agenda manual está disponível na Vercel.', undefined, 'local_only');
    const mode = req.body?.mode;
    if (mode !== 'demo' && mode !== 'real') throw new AppError(400, 'Modo inválido.');
    if (req.body?.confirm !== true) throw new AppError(400, 'Confirme explicitamente a troca de modo.');
    await ctx.settings.mutate((s) => {
      s.mode = mode;
    });
    log.info(`Modo alterado para ${mode === 'demo' ? 'DEMONSTRAÇÃO' : 'REAL'}.`);
    res.json(dto(res.locals.access === 'remote'));
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
    res.json(await Promise.all(PLATFORMS.map(async (p) => {
      const c = await adapterFor(ctx, mc.mode, p).connection(mc);
      const blockers = connectionBlockers(ctx, p, res.locals.storageWarning);
      const limitations: string[] = [];
      const stored = mc.connections.get()[p === 'instagram' ? 'facebook' : p];
      let tokenUnreadable = false;
      if (stored?.tokensEnc && ctx.vault.available) {
        try { ctx.vault.decrypt(stored.tokensEnc, p === 'instagram' ? 'facebook' : p); }
        catch {
          tokenUnreadable = true;
          limitations.push('A autorização salva usa outra chave. Restaure a chave anterior ou reconecte a conta. Nenhum token foi apagado.');
        }
      }
      if (ctx.config.runtime === 'vercel' && p!=='tiktok') limitations.push(p === 'youtube' || p === 'facebook'
        ? cloudPublicationQueue(ctx)?'O executor na nuvem prepara os envios nativos e acompanha os resultados. O agendamento nativo é confirmado pelo status da plataforma.':'Agendamento nativo é mantido quando confirmado pela plataforma. Prepare/retome o envio pelo botão na Agenda; o executor periódico ainda não está configurado.'
        : 'Nesta versão, publique manualmente na plataforma. Não há processo automático no horário planejado.');
      if (p === 'instagram' && stored?.tokensEnc && !c.connected) limitations.push('Selecione no cartão do Facebook a Página vinculada ao Instagram profissional.');
      const identity=connectionIdentity(ctx,p);
      if((p==='facebook'||p==='instagram')&&identity.page&&ctx.vault.available) {
        try {ctx.vault.decrypt<string>(identity.page.tokenEnc,`facebook-page:${identity.page.id}`);}catch {tokenUnreadable=true;}
      }
      const analyticsMissing=missingScopes(ctx,p);
      let expired=false;
      if(stored?.tokensEnc && ctx.vault.available && !tokenUnreadable) {
        const tokens=ctx.vault.decrypt<any>(stored.tokensEnc,p === 'instagram'?'facebook':p);
        expired=!!tokens.expires_at && tokens.expires_at<Date.now() && !tokens.refresh_token;
      }
      const identified=mc.mode==='demo' || !!identity.id;
      const connected=c.connected && identified && !tokenUnreadable && !expired && !(p==='instagram' && stored?.instagramDisconnected);
      return { ...c, connected, accountId:mc.mode==='demo'?c.accountId:identity.id, accountName:identity.name ?? c.accountName, needsReconnect: tokenUnreadable || expired || c.needsReconnect,
        analytics: {state:!connected ? 'disconnected' : stored?.analyticsNeedsReconnect ? 'expired' : analyticsMissing.length ? 'permission' : stored?.analyticsVerifiedAt ? 'available':'no_data',missingScopes:analyticsMissing,lastSync:stored?.analyticsVerifiedAt},
        monetization: p==='youtube' && grantedScopes(ctx,p).includes(MONETARY_SCOPE) ? 'permission_granted':'unavailable',
        canConnect: blockers.length === 0, blockers,
        schedulerConfigured: p==='tiktok'?cloudPublicationQueue(ctx):undefined,
        capabilities: ctx.config.runtime === 'vercel' ? c.capabilities.filter(k => !['queue', 'queue_fallback', ...(p==='tiktok'?[]:['inbox','direct'])].includes(k)) : c.capabilities,
        notes: [...blockers, ...limitations, ...c.notes] };
    })));
  }));

  // POST faz preflight em JSON; GET continua atendendo links existentes.
  r.route('/connections/:platform/start').all(ah(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') throw new AppError(405, 'Método não permitido.');
    requireOAuth(ctx);
    if (ctx.settings.get().mode !== 'real') throw new AppError(409, 'Desative o modo demonstração para conectar contas reais.');
    const platform = String(req.params.platform) as Platform;
    if (!PLATFORMS.includes(platform)) throw new AppError(404, 'Plataforma desconhecida.');
    const blockers = connectionBlockers(ctx, platform);
    if (blockers.length) throw new AppError(409, blockers.join(' '), undefined, 'connection_not_ready');
    if (!ctx.vault.available) throw new AppError(409, 'Defina TOKEN_ENCRYPTION_KEY no .env antes de conectar contas.');
    const ret = String(req.method === 'POST' ? req.body?.returnTo ?? '' : req.query.return ?? '');
    const returnTo = allowedOrigins(ctx).includes(ret) ? ret : ctx.config.webOrigin;
    const nonce = crypto.randomBytes(24).toString('base64url');
    const analytics=req.body?.purpose==='analytics' || req.query.purpose==='analytics';
    const monetary=req.body?.monetary===true;
    if(analytics && !connectionIdentity(ctx,platform).id) throw new AppError(409,'Conecte e selecione esta conta antes de autorizar Analytics.');
    const pack = (p: string, verifier?: string) => ctx.vault.encrypt({ ownerId: ctx.ownerId, nonce, platform: p, requestedPlatform: platform, purpose:analytics?'analytics':'publication', verifier, createdAt: Date.now(), returnTo }, 'oauth-state');
    let state: string;
    let url: string;
    if (platform === 'youtube') {
      if (!ctx.config.google.clientId || !ctx.config.google.clientSecret) throw new AppError(409, 'Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET para conectar o YouTube.');
      const { verifier, challenge } = pkcePair();
      state = pack(platform, verifier);
      url = analytics ? analyticsAuthUrl(ctx,platform,state,challenge,monetary):youtubeAuthUrl(ctx, state, challenge);
    } else if (platform === 'facebook' || platform === 'instagram') {
      if (!ctx.config.meta.appId || !ctx.config.meta.appSecret) throw new AppError(409, 'Configure META_APP_ID e META_APP_SECRET para conectar Facebook/Instagram.');
      state = pack('facebook');
      url = analytics ? analyticsAuthUrl(ctx,platform,state):metaAuthUrl(ctx, state);
    } else if (platform === 'tiktok') {
      if (!ctx.config.tiktok.clientKey || !ctx.config.tiktok.clientSecret || !ctx.config.tiktok.redirectUri) {
        throw new AppError(409, 'Configure TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET e TIKTOK_REDIRECT_URI (HTTPS) no .env.');
      }
      state = pack(platform);
      url = analytics ? analyticsAuthUrl(ctx,platform,state):tiktokAuthUrl(ctx, state);
    } else throw new AppError(404, 'Plataforma desconhecida.');
    if (req.method === 'POST') res.json({ url });
    else res.redirect(302, url);
  }));

  r.get('/oauth/:platform/callback', ah(async (req, res) => {
    requireOAuth(ctx);
    const platform = String(req.params.platform);
    const state = String(req.query.state ?? '');
    let pending: { ownerId?: string; nonce: string; platform: string; requestedPlatform?: Platform; purpose?: string; verifier?: string; createdAt: number; returnTo: string } | undefined;
    try { pending = ctx.vault.decrypt(state, 'oauth-state'); } catch {}
    const back = (q: string) => res.redirect(302, `${pending?.returnTo ?? ctx.config.webOrigin}/#/conexoes?${q}`);
    if (!pending || pending.ownerId !== ctx.ownerId || pending.platform !== platform || Date.now() - pending.createdAt > OAUTH_TTL) {
      res.status(400).json({ error: 'Estado OAuth inválido ou expirado. Volte ao aplicativo e tente conectar novamente.', code: 'invalid_oauth_state' });
      return;
    }
    const nonce = pending.nonce;
    const consumed = await ctx.oauthUsed.mutate(d => {
      for (const [key, expiry] of Object.entries(d.used)) if (expiry < Date.now()) delete d.used[key];
      if (d.used[nonce]) return false;
      d.used[nonce] = Date.now() + OAUTH_TTL;
      return true;
    });
    if (!consumed) throw new AppError(400, 'Estado OAuth já utilizado.', undefined, 'invalid_oauth_state');
    if (req.query.error) return back(`erro=${encodeURIComponent(req.query.error === 'access_denied' ? 'cancelado' : String(req.query.error_description ?? req.query.error))}`);
    const code = String(req.query.code ?? '');
    if (!code) return back(`erro=${encodeURIComponent('A rede não retornou a autorização. Entre novamente para conectar a conta.')}`);
    try {
      const mc = ctx.modes.real;
      if(pending.purpose==='analytics') await exchangeAnalytics(ctx,pending.requestedPlatform!,code,pending.verifier);
      else if (platform === 'youtube') await youtubeExchange(ctx, mc, code, pending.verifier!);
      else if (platform === 'facebook') await metaExchange(ctx, mc, code);
      else if (platform === 'tiktok') await tiktokExchange(ctx, mc, code);
      back(`conectado=${platform}${pending.requestedPlatform === 'instagram' ? '&origem=instagram' : ''}`);
    } catch (err: any) {
      log.error(`OAuth ${platform}:`, err.message);
      back(`erro=${encodeURIComponent(err.message)}`);
    }
  }));

  r.post('/connections/facebook/page', ah(async (req, res) => {
    const pageId = String(req.body?.pageId ?? '');
    const mc = ctx.modes.real;
    await mc.connections.mutate((d) => {
      if (!d.facebook?.pages?.some((p) => p.id === pageId)) throw new AppError(400, 'Página não autorizada.');
      d.facebook.selectedPageId = pageId;
      d.facebook.analyticsVerifiedAt=undefined;
      d.facebook.analyticsNeedsReconnect=false;
    });
    res.json(await adapterFor(ctx, 'real', 'facebook').connection(mc));
  }));

  r.post('/connections/:platform/disconnect', ah(async (req, res) => {
    const p = String(req.params.platform);
    const key = p === 'instagram' ? 'facebook' : p;
    if (!['youtube', 'facebook', 'tiktok'].includes(key)) throw new AppError(404, 'Plataforma desconhecida.');
    await ctx.modes.real.connections.mutate((d) => {
      if(p==='instagram' && d.facebook) d.facebook.instagramDisconnected=true;
      else delete (d as any)[key];
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
