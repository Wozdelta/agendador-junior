// TikTok — Login Kit (Web) + Content Posting API (consultada em 14/11/2026).
// Padrão pessoal: "Ação manual necessária" (copiar descrição + baixar vídeo).
// Com video.upload aprovado: envio à caixa de entrada (inbox) — o criador finaliza no app.
// Com video.publish aprovado e caso de uso elegível: Direct Post com creator_info.
import fs from 'node:fs';
import type { AppContext, ModeContext } from '../context.js';
import { AppError, AuthError, ManualReviewError, PermanentError, RetryableError } from '../lib/errors.js';
import { form, parseRetryAfter, request, type HttpResponse } from '../lib/http.js';
import { addMinutes } from '../lib/time.js';
import type { ConnectionDTO } from '../shared/types.js';
import { getConn, markNeedsReconnect, readTokens, writeTokens } from './tokens.js';
import type { AccountChoice, PlatformAdapter, TaskRuntime } from './types.js';

const API = 'https://open.tiktokapis.com';
const MIN_CHUNK = 5 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;
const MAX_PENDING = 5;

interface TikTokTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at: number;
  open_id: string;
  scope: string;
}

export function tiktokScopes(ctx: AppContext): string[] {
  const s = ['user.info.basic'];
  if (ctx.config.tiktok.uploadApproved) s.push('video.upload');
  if (ctx.config.tiktok.directPostApproved) s.push('video.publish');
  return s;
}

export function tiktokAuthUrl(ctx: AppContext, state: string): string {
  const p = new URLSearchParams({
    client_key: ctx.config.tiktok.clientKey,
    scope: tiktokScopes(ctx).join(','),
    response_type: 'code',
    redirect_uri: ctx.config.tiktok.redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
}

function saveTokens(ctx: AppContext, mc: ModeContext, j: any) {
  const now = ctx.clock.now().getTime();
  const t: TikTokTokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: now + (j.expires_in ?? 7200) * 1000,
    refresh_expires_at: now + (j.refresh_expires_in ?? 180 * 86400) * 1000,
    open_id: j.open_id,
    scope: j.scope ?? '',
  };
  return writeTokens(ctx, mc, 'tiktok', t).then(() => t);
}

export async function tiktokExchange(ctx: AppContext, mc: ModeContext, code: string): Promise<void> {
  const res = await request(`${API}/v2/oauth/token/`, {
    method: 'POST',
    fetchImpl: ctx.fetch,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      client_key: ctx.config.tiktok.clientKey,
      client_secret: ctx.config.tiktok.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: ctx.config.tiktok.redirectUri,
    }),
  });
  if (res.status !== 200 || !res.json?.access_token) {
    throw new AppError(400, `O TikTok recusou a autorização: ${res.json?.error_description ?? res.json?.error ?? res.status}`);
  }
  const t = await saveTokens(ctx, mc, res.json);
  const info = await request(`${API}/v2/user/info/?fields=open_id,display_name`, {
    fetchImpl: ctx.fetch,
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const name = info.json?.data?.user?.display_name ?? t.open_id;
  await mc.connections.mutate((d) => {
    d.tiktok = { ...d.tiktok, accountId: t.open_id, accountName: name, scopes: t.scope.split(','), connectedAt: ctx.clock.now().toISOString() };
  });
}

function classify(res: HttpResponse, what: string): never {
  const code: string = res.json?.error?.code ?? '';
  const msg: string = res.json?.error?.message ?? `HTTP ${res.status}`;
  if (code === 'access_token_invalid' || code === 'scope_not_authorized' || res.status === 401)
    throw new AuthError(`${what}: autorização do TikTok inválida (${code || res.status}). Reconecte o TikTok.`);
  if (code === 'spam_risk_too_many_pending_share')
    throw new RetryableError(`${what}: há 5 envios pendentes no TikTok nas últimas 24 h. Finalize os pendentes no app.`, 3 * 3600_000, 'rate_limit');
  if (code === 'rate_limit_exceeded' || res.status === 429)
    throw new RetryableError(`${what}: limite de requisições do TikTok.`, parseRetryAfter(res.headers.get('retry-after')) ?? 60_000, 'rate_limit');
  if (res.status >= 500) throw new RetryableError(`${what}: erro temporário do TikTok.`);
  throw new PermanentError(`${what}: ${code} — ${msg}`);
}

export class TikTokAdapter implements PlatformAdapter {
  platform = 'tiktok' as const;
  constructor(private ctx: AppContext) {}

  private mode(mc: ModeContext): 'manual' | 'inbox' | 'direct' {
    const c = getConn(mc, 'tiktok');
    const cfg = this.ctx.config.tiktok;
    if (!c?.tokensEnc || c.needsReconnect) return 'manual';
    if (cfg.directPostApproved && c.scopes?.includes('video.publish')) return 'direct';
    if (cfg.uploadApproved && c.scopes?.includes('video.upload')) return 'inbox';
    return 'manual';
  }

  account(mc: ModeContext): AccountChoice {
    const m = this.mode(mc);
    const c = getConn(mc, 'tiktok');
    if (m === 'manual') return { accountId: c?.accountId ?? 'manual', accountName: c?.accountName ?? 'Publicação manual', strategy: 'manual' };
    return { accountId: c!.accountId!, accountName: c!.accountName ?? c!.accountId!, strategy: m };
  }

  async connection(mc: ModeContext): Promise<ConnectionDTO> {
    const c = getConn(mc, 'tiktok');
    const cfg = this.ctx.config.tiktok;
    const m = this.mode(mc);
    return {
      platform: 'tiktok',
      configured: !!(cfg.clientKey && cfg.clientSecret && cfg.redirectUri),
      connected: !!c?.tokensEnc,
      needsReconnect: c?.needsReconnect,
      accountName: c?.accountName,
      accountId: c?.accountId,
      capabilities: ['manual', ...(m !== 'manual' ? [m] : [])],
      notes: [
        m === 'manual' ? 'Modo manual: no horário, copie a descrição, baixe o vídeo e publique pelo app do TikTok.' : '',
        m === 'inbox' ? 'Envio à caixa de entrada: o TikTok notifica você para finalizar a publicação no app (máx. 5 pendentes em 24 h).' : '',
        m === 'direct' ? 'Direct Post habilitado: escolha privacidade e confirme o consentimento em cada vídeo.' : '',
        cfg.uploadApproved ? '' : 'Defina TIKTOK_VIDEO_UPLOAD_APPROVED=true somente depois que o escopo video.upload for aprovado.',
      ].filter(Boolean),
    };
  }

  private async token(rt: { ctx: AppContext; mc: ModeContext }): Promise<string> {
    const { ctx, mc } = rt;
    const t = readTokens<TikTokTokens>(ctx, mc, 'tiktok');
    if (t.expires_at - 60_000 > ctx.clock.now().getTime()) return t.access_token;
    const res = await request(`${API}/v2/oauth/token/`, {
      method: 'POST',
      fetchImpl: ctx.fetch,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_key: ctx.config.tiktok.clientKey, client_secret: ctx.config.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: t.refresh_token }),
    });
    if (res.status !== 200 || !res.json?.access_token) {
      await markNeedsReconnect(mc, 'tiktok');
      throw new AuthError('O refresh token do TikTok expirou ou foi revogado. Reconecte o TikTok.');
    }
    return (await saveTokens(ctx, mc, { ...res.json, open_id: t.open_id })).access_token;
  }

  private async api(rt: TaskRuntime, path: string, body: unknown, what: string, mayCreate = false): Promise<any> {
    const res = await request(`${API}${path}`, {
      method: 'POST',
      fetchImpl: this.ctx.fetch,
      mayCreate,
      headers: { Authorization: `Bearer ${await this.token(rt)}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status !== 200 || (res.json?.error?.code && res.json.error.code !== 'ok')) classify(res, what);
    return res.json?.data;
  }

  async creatorInfo(mc: ModeContext): Promise<any> {
    const res = await request(`${API}/v2/post/publish/creator_info/query/`, {
      method: 'POST',
      fetchImpl: this.ctx.fetch,
      headers: { Authorization: `Bearer ${await this.token({ ctx: this.ctx, mc })}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: '{}',
    });
    if (res.status !== 200 || (res.json?.error?.code && res.json.error.code !== 'ok')) classify(res, 'Consulta do criador');
    return res.json.data;
  }

  async run(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    const strategy = t.remote.strategy ?? 'manual';
    if (strategy === 'manual') {
      await rt.save((x) => {
        x.state = 'manual_action';
        x.manualReason = 'tiktok_manual';
        x.nextRunAt = undefined;
      });
      return;
    }
    if (t.remote.publishId && t.videoUploaded) return this.poll(rt);

    const planned = new Date(t.plannedAt);
    const startAt = strategy === 'inbox' ? addMinutes(planned, -this.ctx.config.tiktok.inboxLeadMinutes) : planned;
    if (rt.now() < startAt) {
      await rt.save((x) => {
        x.state = 'queued';
        x.nextRunAt = startAt.toISOString();
      });
      return;
    }
    if (strategy === 'inbox') {
      const since = rt.now().getTime() - 86400_000;
      const pending = rt.mc.tasks.find(
        (x) => x.platform === 'tiktok' && x.state === 'manual_action' && x.manualReason === 'tiktok_inbox' && new Date(x.remote.sentAt ?? 0).getTime() > since,
      ).length;
      if (pending >= MAX_PENDING) {
        throw new RetryableError(`Já há ${pending} envios pendentes no TikTok nas últimas 24 h (máximo 5). Finalize-os no app.`, 60 * 60_000, 'rate_limit');
      }
    }
    await rt.save((x) => (x.state = 'processing'));
    const m = rt.media();
    let info: any;
    if (strategy === 'direct') {
      info = await this.creatorInfo(rt.mc);
      const level = t.options.privacyLevel;
      if (!t.options.directPostConsent) throw new PermanentError('Direct Post exige o seu consentimento explícito no editor do vídeo.');
      if (!level || !(info.privacy_level_options ?? []).includes(level)) {
        throw new PermanentError(`Privacidade "${level ?? 'não escolhida'}" não está disponível para esta conta agora.`);
      }
      if (info.max_video_post_duration_sec && (m.durationSec ?? 0) > info.max_video_post_duration_sec) {
        throw new PermanentError(`A conta aceita vídeos de até ${info.max_video_post_duration_sec} s.`);
      }
    }
    const chunkSize = m.size < MIN_CHUNK ? m.size : CHUNK;
    const total = Math.max(1, Math.floor(m.size / chunkSize));
    const source_info = { source: 'FILE_UPLOAD', video_size: m.size, chunk_size: chunkSize, total_chunk_count: total };
    const data =
      strategy === 'direct'
        ? await this.api(rt, '/v2/post/publish/video/init/', {
            post_info: {
              title: t.description,
              privacy_level: t.options.privacyLevel,
              disable_comment: !!t.options.disableComment || !!info?.comment_disabled,
              disable_duet: !!t.options.disableDuet || !!info?.duet_disabled,
              disable_stitch: !!t.options.disableStitch || !!info?.stitch_disabled,
              video_cover_timestamp_ms: t.coverFrameMs,
              brand_content_toggle: false,
              brand_organic_toggle: false,
            },
            source_info,
          }, 'Início do Direct Post')
        : await this.api(rt, '/v2/post/publish/inbox/video/init/', { source_info }, 'Início do envio ao TikTok');
    await rt.save((x) => {
      x.remote.publishId = data.publish_id;
      x.remoteId = data.publish_id;
    });
    // Envio sequencial dos pedaços (o último pode ser maior que chunk_size).
    const file = rt.mediaPath(m);
    for (let i = 0; i < total; i++) {
      const start = i * chunkSize;
      const end = i === total - 1 ? m.size - 1 : start + chunkSize - 1;
      const res = await request(data.upload_url, {
        method: 'PUT',
        fetchImpl: this.ctx.fetch,
        mayCreate: i === total - 1,
        timeoutMs: 30 * 60_000,
        duplex: 'half',
        headers: { 'Content-Type': m.mime, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${m.size}` },
        body: fs.createReadStream(file, { start, end }) as any,
      });
      if (res.status !== 201 && res.status !== 206) {
        if (res.status === 403) throw new RetryableError('O link de upload do TikTok expirou; o envio será reiniciado.');
        classify(res, 'Upload para o TikTok');
      }
    }
    await rt.save((x) => {
      x.videoUploaded = true;
      x.remote.sentAt = rt.now().toISOString();
      x.nextRunAt = addMinutes(rt.now(), 1).toISOString();
    });
    await rt.note(strategy === 'direct' ? 'Vídeo enviado ao TikTok (Direct Post).' : 'Vídeo enviado ao TikTok (caixa de entrada).');
    await this.poll(rt);
  }

  private async poll(rt: TaskRuntime) {
    const d = await this.api(rt, '/v2/post/publish/status/fetch/', { publish_id: rt.task.remote.publishId }, 'Status do envio');
    const now = rt.now();
    switch (d?.status) {
      case 'SEND_TO_USER_INBOX':
        await rt.save((x) => {
          x.state = 'manual_action';
          x.manualReason = 'tiktok_inbox';
          x.nextRunAt = addMinutes(now, 30).toISOString();
        });
        return;
      case 'PUBLISH_COMPLETE': {
        const postId = d.publicaly_available_post_id?.[0];
        await rt.save((x) => {
          x.state = 'published';
          x.effectiveAt = now.toISOString();
          x.nextRunAt = undefined;
          if (postId) x.remoteUrl = `https://www.tiktok.com/@/video/${postId}`;
        });
        await rt.note('Publicação confirmada pelo TikTok.');
        return;
      }
      case 'FAILED':
        throw new PermanentError(`O TikTok recusou o envio: ${d.fail_reason ?? 'sem detalhe'}.`);
      default:
        await rt.save((x) => {
          x.state = x.state === 'manual_action' ? x.state : 'processing';
          x.nextRunAt = addMinutes(now, 1).toISOString();
        });
    }
  }

  async reconcile(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    if (t.remote.publishId) {
      let d: any;
      try {
        d = await this.api(rt, '/v2/post/publish/status/fetch/', { publish_id: t.remote.publishId }, 'Status do envio');
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new ManualReviewError('Não foi possível confirmar o envio ao TikTok. Confira a caixa de entrada do app.');
      }
      if (d?.status && d.status !== 'FAILED' && d.status !== 'PROCESSING_UPLOAD') {
        await rt.save((x) => {
          x.videoUploaded = true;
          x.remote.needsReconcile = false;
        });
        await rt.note('Reconciliação: o TikTok já tinha recebido o vídeo. Nada será reenviado.');
        return this.poll(rt);
      }
      // Upload incompleto não gera publicação: reinicia com um novo publish_id.
      await rt.save((x) => {
        x.remote.publishId = undefined;
        x.videoUploaded = false;
      });
    }
    await rt.save((x) => (x.remote.needsReconcile = false));
    return this.run(rt);
  }

  async cancelRemote(rt: TaskRuntime): Promise<void> {
    if (rt.task.videoUploaded && rt.task.remote.strategy !== 'manual') {
      throw new AppError(409, 'O vídeo já está na caixa de entrada do TikTok; descarte o rascunho pelo app do TikTok.');
    }
  }
}
