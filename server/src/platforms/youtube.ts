import { openMedia, readMedia } from '../lib/mediaio.js';
// YouTube Shorts — YouTube Data API v3 (consultada em 14/11/2026).
// OAuth 2.0 para aplicativos de servidor web com acesso offline e PKCE.
// Upload retomável em videos.insert com privacyStatus=private + publishAt.
// Capa por thumbnails.set após processingDetails.processingStatus=succeeded.
import { DateTime } from 'luxon';
import type { AppContext, ModeContext } from '../context.js';
import { AppError, AuthError, LateError, ManualReviewError, PermanentError, RetryableError } from '../lib/errors.js';
import { form, request, type HttpResponse } from '../lib/http.js';
import { addMinutes } from '../lib/time.js';
import type { ConnectionDTO } from '../shared/types.js';
import { RULES } from '../shared/limits.js';
import { getConn, markNeedsReconnect, readTokens, writeTokens } from './tokens.js';
import type { AccountChoice, PlatformAdapter, TaskRuntime } from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube', // listar, confirmar, alterar e cancelar agendamentos
];

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

export function youtubeAuthUrl(ctx: AppContext, state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: ctx.config.google.clientId,
    redirect_uri: ctx.config.google.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${p}`;
}

export async function youtubeExchange(ctx: AppContext, mc: ModeContext, code: string, verifier: string): Promise<void> {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    fetchImpl: ctx.fetch,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      code,
      client_id: ctx.config.google.clientId,
      client_secret: ctx.config.google.clientSecret,
      redirect_uri: ctx.config.google.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (res.status !== 200) throw new AppError(400, `O Google recusou a autorização: ${res.json?.error_description ?? res.json?.error ?? res.status}`);
  const tokens: GoogleTokens = {
    access_token: res.json.access_token,
    refresh_token: res.json.refresh_token,
    expires_at: ctx.clock.now().getTime() + (res.json.expires_in ?? 3600) * 1000,
    scope: res.json.scope,
  };
  if (!tokens.refresh_token) {
    throw new AppError(400, 'O Google não devolveu refresh token. Remova o acesso do app na sua Conta Google e conecte de novo.');
  }
  const ch = await request(`${API}/channels?part=snippet&mine=true`, {
    fetchImpl: ctx.fetch,
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const channel = ch.json?.items?.[0];
  if (!channel) throw new AppError(400, 'A conta autorizada não tem canal do YouTube.');
  await writeTokens(ctx, mc, 'youtube', tokens);
  await mc.connections.mutate((d) => {
    d.youtube = {
      ...d.youtube,
      accountId: channel.id,
      accountName: channel.snippet?.title ?? channel.id,
      scopes: String(tokens.scope ?? '').split(' '),
      connectedAt: ctx.clock.now().toISOString(),
    };
  });
}

/** Erros da API: separa cota do projeto, limite do canal, rate limit e autorização. */
function classify(res: HttpResponse, what: string, now: Date): never {
  const reason: string = res.json?.error?.errors?.[0]?.reason ?? res.json?.error?.status ?? '';
  const msg: string = res.json?.error?.message ?? '';
  if (res.status === 401) throw new AuthError(`${what}: autorização do Google expirada ou revogada. Reconecte o YouTube.`);
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    // A cota do projeto zera à meia-noite no horário do Pacífico.
    const reset = DateTime.fromJSDate(now).setZone('America/Los_Angeles').plus({ days: 1 }).startOf('day');
    throw new RetryableError(
      `${what}: cota diária do PROJETO no Google Cloud esgotada. Nova tentativa após a renovação da cota.`,
      reset.toMillis() - now.getTime() + 60_000,
      'quota',
    );
  }
  if (reason === 'uploadLimitExceeded') {
    throw new RetryableError(`${what}: o CANAL atingiu o limite de envios definido pelo YouTube. Nova tentativa em algumas horas.`, 6 * 3600_000, 'quota');
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || res.status === 429) {
    throw new RetryableError(`${what}: limite de requisições atingido.`, undefined, 'rate_limit');
  }
  if (res.status >= 500) throw new RetryableError(`${what}: erro temporário do YouTube (${res.status}).`);
  if (reason === 'forbidden' && what.includes('capa')) {
    throw new PermanentError(`${what}: o canal não tem permissão para capas personalizadas (verifique o canal em youtube.com/verify).`);
  }
  throw new PermanentError(`${what}: ${msg || reason || `HTTP ${res.status}`}`);
}

export class YouTubeAdapter implements PlatformAdapter {
  platform = 'youtube' as const;
  constructor(private ctx: AppContext) {}

  account(mc: ModeContext): AccountChoice {
    const c = getConn(mc, 'youtube');
    if (!c?.tokensEnc) throw new AppError(422, 'Conecte o YouTube em "Conexões" antes de agendar.');
    if (c.needsReconnect) throw new AppError(422, 'A autorização do YouTube expirou. Reconecte em "Conexões".');
    return { accountId: c.accountId!, accountName: c.accountName ?? c.accountId!, strategy: 'native' };
  }

  async connection(mc: ModeContext): Promise<ConnectionDTO> {
    const c = getConn(mc, 'youtube');
    const configured = !!(this.ctx.config.google.clientId && this.ctx.config.google.clientSecret);
    return {
      platform: 'youtube',
      configured,
      connected: !!c?.tokensEnc,
      needsReconnect: c?.needsReconnect,
      accountName: c?.accountName,
      accountId: c?.accountId,
      capabilities: c?.tokensEnc ? ['native_schedule', 'cover_image'] : [],
      notes: [
        configured ? '' : 'Preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env.',
        'Apps com tela de consentimento em "Testing" (tipo externo) recebem refresh token que expira em 7 dias.',
      ].filter(Boolean),
    };
  }

  private async token(rt: { ctx: AppContext; mc: ModeContext }): Promise<string> {
    const { ctx, mc } = rt;
    const t = readTokens<GoogleTokens>(ctx, mc, 'youtube');
    if (t.expires_at - 60_000 > ctx.clock.now().getTime()) return t.access_token;
    if (!t.refresh_token) throw new AuthError('Refresh token ausente. Reconecte o YouTube.');
    const res = await request(TOKEN_URL, {
      method: 'POST',
      fetchImpl: ctx.fetch,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: ctx.config.google.clientId,
        client_secret: ctx.config.google.clientSecret,
        refresh_token: t.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (res.status === 400 && res.json?.error === 'invalid_grant') {
      await markNeedsReconnect(mc, 'youtube');
      throw new AuthError('O refresh token do Google expirou ou foi revogado (em modo "Testing" ele dura 7 dias). Reconecte o YouTube.');
    }
    if (res.status !== 200) classify(res, 'Renovação do token', ctx.clock.now());
    const next: GoogleTokens = { ...t, access_token: res.json.access_token, expires_at: ctx.clock.now().getTime() + res.json.expires_in * 1000 };
    await writeTokens(ctx, mc, 'youtube', next);
    return next.access_token;
  }

  private async getVideo(rt: TaskRuntime, id: string, parts = 'status,processingDetails,snippet') {
    const res = await request(`${API}/videos?part=${parts}&id=${encodeURIComponent(id)}`, {
      fetchImpl: this.ctx.fetch,
      headers: { Authorization: `Bearer ${await this.token(rt)}` },
    });
    if (res.status !== 200) classify(res, 'Consulta do vídeo', rt.now());
    return res.json?.items?.[0] as any | undefined;
  }

  async run(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    if (t.phase === 'scheduled') return this.afterScheduled(rt);
    if (!t.remoteId) {
      // publishAt no passado faz o YouTube publicar na hora: nunca enviar perto/depois do horário.
      if (new Date(t.plannedAt).getTime() - rt.now().getTime() < 5 * 60_000) {
        throw new LateError('Horário muito próximo ou já passado: o YouTube publicaria imediatamente.');
      }
      const m = rt.media();
      if ((m.durationSec ?? 0) > RULES.youtube.maxDurationSec!) throw new PermanentError('Vídeo acima de 3 minutos não é elegível a Short.');
      if (m.width && m.height && m.width > m.height) throw new PermanentError('Shorts precisam ser verticais ou quadrados.');
      await rt.save((x) => (x.state = 'processing'));
      if (!t.remote.sessionUri) await this.createSession(rt);
      await this.upload(rt);
      if (!rt.task.remoteId) return;
    }
    await this.verify(rt);
  }

  private async createSession(rt: TaskRuntime) {
    const t = rt.task;
    const m = rt.media();
    const res = await request(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      fetchImpl: this.ctx.fetch,
      headers: {
        Authorization: `Bearer ${await this.token(rt)}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(m.size),
        'X-Upload-Content-Type': m.mime,
      },
      body: JSON.stringify({
        snippet: { title: t.title, description: t.description, categoryId: '22' },
        status: {
          privacyStatus: 'private',
          publishAt: new Date(t.plannedAt).toISOString(),
          selfDeclaredMadeForKids: !!t.options.madeForKids,
        },
      }),
    });
    const location = res.headers.get('location');
    if (res.status !== 200 || !location) classify(res, 'Início do upload', rt.now());
    await rt.save((x) => {
      x.remote.sessionUri = location;
      x.phase = 'uploading';
    });
    await rt.note('Sessão de upload retomável criada no YouTube.');
  }

  /** Consulta o progresso da sessão: devolve o próximo byte ou o vídeo pronto. */
  private async sessionStatus(rt: TaskRuntime): Promise<{ next: number } | { video: any } | { expired: true }> {
    const m = rt.media();
    const res = await request(rt.task.remote.sessionUri, {
      method: 'PUT',
      fetchImpl: this.ctx.fetch,
      headers: { Authorization: `Bearer ${await this.token(rt)}`, 'Content-Range': `bytes */${m.size}`, 'Content-Length': '0' },
    });
    if (res.status === 200 || res.status === 201) return { video: res.json };
    if (res.status === 308) {
      const range = res.headers.get('range');
      return { next: range ? Number(range.split('-')[1]) + 1 : 0 };
    }
    if (res.status === 404 || res.status === 410) return { expired: true };
    classify(res, 'Consulta da sessão de upload', rt.now());
  }

  private async upload(rt: TaskRuntime) {
    const m = rt.media();
    const st = await this.sessionStatus(rt);
    if ('expired' in st) {
      await rt.save((x) => {
        x.remote.sessionUri = undefined;
        x.phase = '';
      });
      throw new RetryableError('A sessão de upload do YouTube expirou; uma nova será criada.');
    }
    let video = 'video' in st ? st.video : undefined;
    if (!video && 'next' in st) {
      const start = st.next;
      const end = this.ctx.config.runtime === 'vercel' ? Math.min(m.size - 1, start + 8 * 1024 * 1024 - 1) : m.size - 1;
      const res = await request(rt.task.remote.sessionUri, {
        method: 'PUT',
        fetchImpl: this.ctx.fetch,
        mayCreate: true,
        timeoutMs: 6 * 3600_000,
        duplex: 'half',
        headers: {
          Authorization: `Bearer ${await this.token(rt)}`,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${m.size}`,
          'Content-Type': m.mime,
        },
        body: await openMedia(this.ctx, rt.mc, m, { start, end }) as any,
      });
      if (res.status === 308 && end < m.size - 1) {
        await rt.save(x => { x.nextRunAt = rt.now().toISOString(); });
        return;
      }
      if (res.status !== 200 && res.status !== 201) {
        if (res.status === 308 || res.status >= 500) throw new RetryableError('Upload interrompido; será retomado do ponto em que parou.');
        classify(res, 'Upload do vídeo', rt.now());
      }
      video = res.json;
    }
    await rt.save((x) => {
      x.remoteId = video.id;
      x.videoUploaded = true;
      x.phase = 'uploaded';
      x.remoteUrl = `https://www.youtube.com/shorts/${video.id}`;
    });
    await rt.note(`Vídeo enviado ao YouTube (ID ${video.id}).`);
  }

  /** Confere pelo ID remoto se o agendamento nativo ficou registrado. */
  private async verify(rt: TaskRuntime) {
    const v = await this.getVideo(rt, rt.task.remoteId!);
    if (!v) {
      await rt.save((x) => (x.nextRunAt = addMinutes(rt.now(), 1).toISOString()));
      return;
    }
    const publishAt = v.status?.publishAt ? new Date(v.status.publishAt).getTime() : 0;
    if (v.status?.privacyStatus !== 'private' || Math.abs(publishAt - new Date(rt.task.plannedAt).getTime()) > 1000) {
      throw new PermanentError(
        `O YouTube não confirmou o agendamento (privacidade "${v.status?.privacyStatus}", publishAt ${v.status?.publishAt ?? 'ausente'}).`,
      );
    }
    await rt.save((x) => {
      x.state = 'scheduled_remote';
      x.nativeSchedule = true;
      x.phase = 'scheduled';
      x.lastError = undefined;
      x.cover = x.coverId ? { state: 'pending', message: 'Aguardando o processamento para aplicar a capa.' } : { state: 'none' };
      x.nextRunAt = addMinutes(rt.now(), 1).toISOString();
    });
    await rt.note(`Agendamento nativo confirmado pelo YouTube para ${v.status.publishAt}.`);
  }

  private async afterScheduled(rt: TaskRuntime) {
    const t = rt.task;
    const v = await this.getVideo(rt, t.remoteId!);
    if (!v) throw new PermanentError('O vídeo não foi encontrado no canal (pode ter sido excluído no YouTube Studio).');
    const now = rt.now();

    if (t.cover.state === 'pending') {
      const ps = v.processingDetails?.processingStatus;
      if (ps === 'succeeded') await this.applyCover(rt);
      else if (ps === 'failed' || ps === 'terminated')
        await rt.save((x) => (x.cover = { state: 'failed', message: `Processamento do YouTube: ${ps}. O vídeo foi enviado; a capa precisa de atenção.` }));
    }

    if (now >= new Date(t.plannedAt)) {
      if (v.status?.privacyStatus === 'public') {
        await rt.save((x) => {
          x.state = 'published';
          x.effectiveAt = x.plannedAt;
          x.nextRunAt = undefined;
        });
        await rt.note('Publicação confirmada pelo YouTube (vídeo público).');
        return;
      }
    }
    const planned = new Date(t.plannedAt);
    let next: Date;
    if (rt.task.cover.state === 'pending') next = addMinutes(now, 2);
    else if (now < planned) next = planned;
    else next = addMinutes(now, now.getTime() - planned.getTime() > 2 * 3600_000 ? 30 : 5);
    await rt.save((x) => (x.nextRunAt = next.toISOString()));
  }

  private async applyCover(rt: TaskRuntime) {
    const cover = rt.cover();
    if (!cover) return;
    const res = await request(`${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(rt.task.remoteId!)}`, {
      method: 'POST',
      fetchImpl: this.ctx.fetch,
      headers: { Authorization: `Bearer ${await this.token(rt)}`, 'Content-Type': cover.mime },
      body: new Uint8Array(await readMedia(this.ctx, rt.mc, cover)),
    });
    if (res.status === 200) {
      await rt.save((x) => (x.cover = { state: 'applied', message: 'Capa aplicada com thumbnails.set.' }));
      await rt.note('Capa personalizada aplicada no YouTube.');
      return;
    }
    try {
      classify(res, 'Envio da capa', rt.now());
    } catch (err: any) {
      const attempts = (rt.task.remote.coverAttempts ?? 0) + 1;
      const giveUp = !(err instanceof RetryableError) || attempts >= 4;
      await rt.save((x) => {
        x.remote.coverAttempts = attempts;
        x.cover = giveUp
          ? { state: 'failed', message: `O vídeo foi enviado e está agendado, mas a capa precisa de atenção: ${err.message}` }
          : { state: 'pending', message: err.message };
      });
    }
  }

  async reconcile(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    if (t.remoteId) {
      await rt.save((x) => (x.remote.needsReconcile = false));
      return this.run(rt);
    }
    if (!t.remote.sessionUri) {
      // Nenhuma sessão: nada pode ter sido criado.
      await rt.save((x) => (x.remote.needsReconcile = false));
      return this.run(rt);
    }
    const st = await this.sessionStatus(rt);
    if ('expired' in st) {
      throw new ManualReviewError('A sessão de upload expirou sem confirmação. Confira no YouTube Studio se o vídeo foi criado.');
    }
    await rt.save((x) => (x.remote.needsReconcile = false));
    await rt.note('Reconciliação: sessão de upload consultada pelo ID; retomando sem duplicar.');
    return this.run(rt);
  }

  private async putStatus(rt: TaskRuntime, publishAt: string | null) {
    const body = {
      id: rt.task.remoteId,
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: !!rt.task.options.madeForKids,
        ...(publishAt ? { publishAt } : {}),
      },
    };
    const res = await request(`${API}/videos?part=status`, {
      method: 'PUT',
      fetchImpl: this.ctx.fetch,
      headers: { Authorization: `Bearer ${await this.token(rt)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) classify(res, 'Atualização do agendamento', rt.now());
  }

  async cancelRemote(rt: TaskRuntime): Promise<void> {
    if (!rt.task.remoteId) return;
    await this.putStatus(rt, null);
    const v = await this.getVideo(rt, rt.task.remoteId, 'status');
    if (v?.status?.publishAt) throw new RetryableError('O YouTube ainda mostra o agendamento; tente cancelar novamente.');
    await rt.note('Agendamento removido no YouTube (o vídeo continua privado no canal).');
  }

  async updateRemote(rt: TaskRuntime, changes: { title?: string; description?: string; plannedAt?: string }) {
    if (!rt.task.remoteId) return;
    if (changes.plannedAt) {
      await this.putStatus(rt, new Date(changes.plannedAt).toISOString());
    }
    if (changes.title !== undefined || changes.description !== undefined) {
      const v = await this.getVideo(rt, rt.task.remoteId, 'snippet');
      const snippet = { ...v.snippet, title: changes.title ?? v.snippet.title, description: changes.description ?? v.snippet.description };
      const res = await request(`${API}/videos?part=snippet`, {
        method: 'PUT',
        fetchImpl: this.ctx.fetch,
        headers: { Authorization: `Bearer ${await this.token(rt)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rt.task.remoteId, snippet: { title: snippet.title, description: snippet.description, categoryId: snippet.categoryId ?? '22' } }),
      });
      if (res.status !== 200) classify(res, 'Atualização do texto', rt.now());
    }
    const v = await this.getVideo(rt, rt.task.remoteId, 'status,snippet');
    if (changes.plannedAt && new Date(v?.status?.publishAt ?? 0).getTime() !== new Date(changes.plannedAt).getTime()) {
      throw new RetryableError('O YouTube não confirmou o novo horário.');
    }
  }
}
