import { openMedia } from '../lib/mediaio.js';
// Instagram Reels — Instagram API com Facebook Login (Graph v27.0, consultada em 14/11/2026).
// Container media_type=REELS criado perto do horário, status_code até FINISHED e
// media_publish no horário. Containers expiram em 24 h; 400 containers por 24 h;
// limite de publicação consultado em /content_publishing_limit.
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext, ModeContext } from '../context.js';
import { signMediaToken } from '../lib/crypto.js';
import { AppError, ManualReviewError, PermanentError, RetryableError } from '../lib/errors.js';
import { request } from '../lib/http.js';
import { toJpeg } from '../lib/media.js';
import { addMinutes } from '../lib/time.js';
import type { ConnectionDTO } from '../shared/types.js';
import type { MediaRecord } from '../domain/model.js';
import { graph, handleMetaAuthFailure, metaError, selectedPage } from './meta.js';
import { getConn } from './tokens.js';
import type { AccountChoice, PlatformAdapter, TaskRuntime } from './types.js';

export function publicMediaUrl(ctx: AppContext, mc: ModeContext, m: MediaRecord): string | null {
  if (m.blobUrl) return m.blobUrl;
  if (!ctx.config.publicBaseUrl) return null;
  const exp = ctx.clock.now().getTime() + ctx.config.mediaLinkTtlMinutes * 60_000;
  // O token amarra modo + nome interno do arquivo + validade: serve só aquele arquivo.
  const token = signMediaToken(ctx.linkSecret, `${mc.mode}:${m.internalName}`, exp);
  return `${ctx.config.publicBaseUrl}/public/media/${token}/${m.internalName}`;
}

export class InstagramAdapter implements PlatformAdapter {
  platform = 'instagram' as const;
  constructor(private ctx: AppContext) {}

  account(mc: ModeContext): AccountChoice {
    const c = getConn(mc, 'facebook');
    if (!c?.tokensEnc) throw new AppError(422, 'Conecte o Facebook (Instagram com Facebook Login) em "Conexões".');
    const page = c.pages?.find((p) => p.id === c.selectedPageId);
    if (!page) throw new AppError(422, 'Escolha a Página do Facebook vinculada ao Instagram em "Conexões".');
    if (!page.instagram) throw new AppError(422, `A Página "${page.name}" não tem conta profissional do Instagram vinculada.`);
    if (!this.ctx.config.meta.igResumable && !this.ctx.config.publicBaseUrl) {
      throw new AppError(422, 'Instagram: configure PUBLIC_BASE_URL (HTTPS) para a Meta baixar o vídeo, ou ative IG_RESUMABLE_UPLOAD (requer Facebook Login for Business).');
    }
    return { accountId: page.instagram.id, accountName: `@${page.instagram.username}`, strategy: 'queue' };
  }

  async connection(mc: ModeContext): Promise<ConnectionDTO> {
    const c = getConn(mc, 'facebook');
    const page = c?.pages?.find((p) => p.id === c.selectedPageId);
    const cfg = this.ctx.config;
    const caps: string[] = [];
    if (page?.instagram) {
      caps.push('queue', 'cover_frame');
      if (cfg.publicBaseUrl) caps.push('cover_image');
      if (cfg.meta.igResumable) caps.push('resumable');
    }
    return {
      platform: 'instagram',
      configured: !!(cfg.meta.appId && cfg.meta.appSecret),
      connected: !!page?.instagram,
      needsReconnect: c?.needsReconnect,
      accountName: page?.instagram ? `@${page.instagram.username}` : undefined,
      accountId: page?.instagram?.id,
      capabilities: caps,
      notes: [
        page && !page.instagram ? `A Página "${page.name}" não tem conta profissional do Instagram vinculada.` : '',
        'O Instagram não tem agendamento nativo pela API: o app cria o container antes e publica às 12:00 (Node precisa estar ligado).',
        cfg.publicBaseUrl ? '' : 'Sem PUBLIC_BASE_URL: a capa usa um quadro (thumb_offset) e a imagem fica para uso manual.',
      ].filter(Boolean),
    };
  }

  async run(rt: TaskRuntime): Promise<void> {
    try {
      await this.step(rt);
    } catch (err) {
      await handleMetaAuthFailure(rt.mc, err);
      throw err;
    }
  }

  private async limitOk(rt: TaskRuntime, igId: string, token: string) {
    const r = await graph(this.ctx, `/${igId}/content_publishing_limit`, {
      token,
      params: { fields: 'quota_usage,config' },
      what: 'Consulta do limite de publicação',
    });
    const d = r.data?.[0];
    const total = d?.config?.quota_total;
    if (total && d.quota_usage >= total) {
      throw new RetryableError(`Limite de publicação do Instagram atingido (${d.quota_usage}/${total} em 24 h).`, 60 * 60_000, 'rate_limit');
    }
  }

  private async step(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    const cfg = this.ctx.config;
    const now = rt.now();
    const planned = new Date(t.plannedAt);
    const createAt = addMinutes(planned, -cfg.meta.igContainerLeadMinutes);

    if (!t.remote.containerId && now < createAt) {
      await rt.save((x) => {
        x.state = 'queued';
        x.nextRunAt = createAt.toISOString();
      });
      return;
    }
    const page = selectedPage(this.ctx, rt.mc);
    if (!page.instagram) throw new PermanentError('A Página selecionada não tem Instagram profissional vinculado.');
    const igId = page.instagram.id;

    if (!t.remote.containerId) {
      await this.limitOk(rt, igId, page.token);
      await rt.save((x) => (x.state = 'processing'));
      await this.createContainer(rt, igId, page.token);
    }
    if (rt.task.phase === 'upload') await this.resumableUpload(rt, page.token);
    if (rt.task.phase === 'container') await this.pollContainer(rt, page.token);
    if (rt.task.phase === 'ready') await this.publish(rt, igId, page.token);
  }

  private async coverUrl(rt: TaskRuntime): Promise<string | null> {
    const cover = rt.cover();
    if (!cover || !this.ctx.config.publicBaseUrl) return null;
    if (cover.blobUrl) return cover.mime === 'image/jpeg' ? cover.blobUrl : null;
    let jpeg = cover;
    if (cover.mime !== 'image/jpeg') {
      // A capa do Reel precisa ser JPEG: gera uma cópia convertida.
      const out = `${path.parse(cover.internalName).name}.cover.jpg`;
      const full = path.join(rt.mc.mediaDir, out);
      if (!fs.existsSync(full)) await toJpeg(this.ctx.config.ffmpegPath, rt.mediaPath(cover), full);
      jpeg = { ...cover, internalName: out, mime: 'image/jpeg' };
    }
    return publicMediaUrl(this.ctx, rt.mc, jpeg);
  }

  private async createContainer(rt: TaskRuntime, igId: string, token: string) {
    const t = rt.task;
    const resumable = this.ctx.config.meta.igResumable;
    const cover = await this.coverUrl(rt);
    const params: Record<string, any> = { media_type: 'REELS', caption: t.description };
    if (resumable) params.upload_type = 'resumable';
    else {
      const url = publicMediaUrl(this.ctx, rt.mc, rt.media());
      if (!url) throw new PermanentError('PUBLIC_BASE_URL não configurado: a Meta não tem como baixar o vídeo.');
      params.video_url = url;
      params.share_to_feed = true;
    }
    if (cover) params.cover_url = cover;
    else params.thumb_offset = t.coverFrameMs;
    const r = await graph(this.ctx, `/${igId}/media`, { method: 'POST', token, params, what: 'Criação do container' });
    await rt.save((x) => {
      x.remote.containerId = r.id;
      x.remote.containerCreatedAt = rt.now().toISOString();
      x.remote.uploadUri = r.uri;
      x.phase = resumable ? 'upload' : 'container';
      x.cover = cover
        ? { state: 'pending', message: 'Capa enviada por cover_url; aguardando o processamento.' }
        : x.coverId
          ? { state: 'manual', message: `Usando o quadro em ${x.coverFrameMs} ms (thumb_offset). A imagem original fica disponível para uso manual.` }
          : { state: 'frame', message: `Quadro em ${x.coverFrameMs} ms (thumb_offset).` };
      x.nextRunAt = addMinutes(rt.now(), 1).toISOString();
    });
    await rt.note(`Container do Reel criado (${r.id}).`);
  }

  private async resumableUpload(rt: TaskRuntime, token: string) {
    const m = rt.media();
    const url = rt.task.remote.uploadUri ?? `https://rupload.facebook.com/ig-api-upload/${this.ctx.config.meta.graphVersion}/${rt.task.remote.containerId}`;
    const res = await request(url, {
      method: 'POST',
      fetchImpl: this.ctx.fetch,
      timeoutMs: 6 * 3600_000,
      duplex: 'half',
      headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(m.size), 'Content-Type': 'application/octet-stream' },
      body: await openMedia(this.ctx, rt.mc, m) as any,
    });
    if (res.status !== 200 || res.json?.success === false) throw metaError(res, 'Upload do vídeo para o Instagram');
    await rt.save((x) => {
      x.phase = 'container';
      x.videoUploaded = true;
    });
  }

  private async pollContainer(rt: TaskRuntime, token: string) {
    const r = await graph(this.ctx, `/${rt.task.remote.containerId}`, { token, params: { fields: 'status_code,status' }, what: 'Status do container' });
    const now = rt.now();
    switch (r.status_code) {
      case 'FINISHED':
        await rt.save((x) => {
          x.phase = 'ready';
          x.videoUploaded = true;
          if (x.cover.state === 'pending') x.cover = { state: 'applied', message: 'Capa aplicada via cover_url.' };
          x.nextRunAt = x.plannedAt;
        });
        return;
      case 'PUBLISHED':
        await rt.save((x) => (x.phase = 'ready'));
        return;
      case 'EXPIRED':
        await rt.save((x) => {
          x.remote.containerId = undefined;
          x.phase = '';
          x.nextRunAt = now.toISOString();
        });
        await rt.note('Container expirou (24 h); um novo será criado.');
        return;
      case 'ERROR':
        throw new PermanentError(`O Instagram não conseguiu processar o vídeo: ${r.status ?? 'erro sem detalhe'}.`);
      default: {
        const planned = new Date(rt.task.plannedAt);
        const note = now >= planned ? 'Às 12:00 o vídeo ainda estava em processamento no Instagram; será publicado assim que ficar pronto (dentro da tolerância).' : undefined;
        await rt.save((x) => {
          x.state = 'processing';
          x.nextRunAt = addMinutes(now, 1).toISOString();
          if (note && !x.delayNote) {
            x.delayNote = note;
            x.history.push({ at: now.toISOString(), message: note });
          }
        });
      }
    }
  }

  private async publish(rt: TaskRuntime, igId: string, token: string) {
    const t = rt.task;
    if (rt.now() < new Date(t.plannedAt)) {
      await rt.save((x) => {
        x.state = 'processing';
        x.nextRunAt = x.plannedAt;
      });
      return;
    }
    await this.limitOk(rt, igId, token);
    const r = await graph(this.ctx, `/${igId}/media_publish`, {
      method: 'POST',
      token,
      params: { creation_id: t.remote.containerId },
      mayCreate: true,
      what: 'Publicação do Reel',
    });
    await this.markPublished(rt, token, r.id);
  }

  private async markPublished(rt: TaskRuntime, token: string, mediaId?: string) {
    let permalink: string | undefined;
    if (mediaId) {
      try {
        permalink = (await graph(this.ctx, `/${mediaId}`, { token, params: { fields: 'permalink' }, what: 'Link do Reel' })).permalink;
      } catch {
        permalink = undefined;
      }
    }
    await rt.save((x) => {
      x.state = 'published';
      x.phase = 'done';
      x.remoteId = mediaId ?? x.remote.containerId;
      x.remoteUrl = permalink;
      x.effectiveAt = rt.now().toISOString();
      x.nextRunAt = undefined;
    });
    await rt.note('Publicação confirmada pelo Instagram.');
  }

  async reconcile(rt: TaskRuntime): Promise<void> {
    const cid = rt.task.remote.containerId;
    if (cid && rt.task.phase === 'ready') {
      const page = selectedPage(this.ctx, rt.mc);
      let r: any;
      try {
        r = await graph(this.ctx, `/${cid}`, { token: page.token, params: { fields: 'status_code' }, what: 'Status do container' });
      } catch {
        throw new ManualReviewError('Não foi possível confirmar se o Reel foi publicado. Confira no Instagram.');
      }
      if (r.status_code === 'PUBLISHED') {
        await rt.note('Reconciliação: o container já estava publicado. Nada será reenviado.');
        await rt.save((x) => (x.remote.needsReconcile = false));
        return this.markPublished(rt, page.token);
      }
    }
    await rt.save((x) => (x.remote.needsReconcile = false));
    return this.run(rt);
  }

  async cancelRemote(): Promise<void> {
    // Containers não publicados expiram sozinhos em 24 h; nada a cancelar remotamente.
  }

  async updateRemote(rt: TaskRuntime): Promise<void> {
    // Texto e horário vivem no app até o media_publish. Se o container já existe,
    // descarta-o para recriar com a nova legenda.
    await rt.save((x) => {
      x.remote.containerId = undefined;
      x.phase = '';
    });
  }
}
