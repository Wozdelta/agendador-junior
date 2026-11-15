import { openMedia, readMedia } from '../lib/mediaio.js';
// Facebook Reels — Reels Publishing API (Graph v27.0, consultada em 14/11/2026).
// start -> upload em rupload.facebook.com -> status -> finish (SCHEDULED + scheduled_publish_time).
// Janela documentada: mais de 10 minutos e até 29 dias a partir do pedido.
// Limite: 30 Reels publicados via API por Página em 24 h (regra do endpoint de Reels,
// diferente do limite do feed da Página).
import type { AppContext, ModeContext } from '../context.js';
import { AppError, LateError, PermanentError, RetryableError } from '../lib/errors.js';
import { request } from '../lib/http.js';
import { addMinutes } from '../lib/time.js';
import type { ConnectionDTO } from '../shared/types.js';
import { graph, handleMetaAuthFailure, metaError, selectedPage } from './meta.js';
import { getConn } from './tokens.js';
import type { AccountChoice, PlatformAdapter, TaskRuntime } from './types.js';

const WINDOW_MAX_MS = 29 * 24 * 3600_000;
const WINDOW_MIN_MS = 10 * 60_000;
const SAFETY_MS = 10 * 60_000; // margem para upload/processamento antes do mínimo de 10 min

export class FacebookAdapter implements PlatformAdapter {
  platform = 'facebook' as const;
  constructor(private ctx: AppContext) {}

  account(mc: ModeContext): AccountChoice {
    const c = getConn(mc, 'facebook');
    if (!c?.tokensEnc) throw new AppError(422, 'Conecte o Facebook em "Conexões" antes de agendar.');
    if (c.needsReconnect) throw new AppError(422, 'A autorização do Facebook expirou. Reconecte em "Conexões".');
    const page = c.pages?.find((p) => p.id === c.selectedPageId);
    if (!page) throw new AppError(422, 'Escolha a Página do Facebook em "Conexões".');
    return { accountId: page.id, accountName: page.name, strategy: 'native' };
  }

  async connection(mc: ModeContext): Promise<ConnectionDTO> {
    const c = getConn(mc, 'facebook');
    const cfg = this.ctx.config.meta;
    const caps = c?.tokensEnc ? ['native_schedule'] : [];
    if (c?.tokensEnc && cfg.reelsCustomCover) caps.push('cover_image');
    if (c?.tokensEnc && cfg.allowDirectPublishFallback) caps.push('queue_fallback');
    return {
      platform: 'facebook',
      configured: !!(cfg.appId && cfg.appSecret),
      connected: !!c?.tokensEnc,
      needsReconnect: c?.needsReconnect,
      accountName: c?.accountName,
      accountId: c?.accountId,
      pages: c?.pages?.map((p) => ({ id: p.id, name: p.name, instagram: p.instagram ?? null })),
      selectedPageId: c?.selectedPageId,
      capabilities: caps,
      notes: [
        cfg.appId ? '' : 'Preencha META_APP_ID e META_APP_SECRET no .env.',
        'Agendamento nativo de Reels: de 10 minutos a 29 dias. Datas além disso ficam na fila do app até a janela abrir.',
        cfg.reelsCustomCover ? '' : 'Capa personalizada de Reels desativada: a imagem fica disponível para uso manual.',
      ].filter(Boolean),
    };
  }

  private page(rt: TaskRuntime) {
    return selectedPage(this.ctx, rt.mc);
  }

  private async status(rt: TaskRuntime, token: string): Promise<any> {
    const r = await graph(this.ctx, `/${rt.task.remoteId}`, { token, params: { fields: 'status' }, what: 'Status do Reel' });
    return r.status ?? {};
  }

  async run(rt: TaskRuntime): Promise<void> {
    try {
      await this.step(rt);
    } catch (err) {
      await handleMetaAuthFailure(rt.mc, err);
      throw err;
    }
  }

  private async step(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    const now = rt.now().getTime();
    const planned = new Date(t.plannedAt).getTime();
    const queueMode = !!t.remote.queueFallback;

    if (t.phase === 'scheduled') return this.afterScheduled(rt);

    if (!queueMode && !t.remoteId) {
      if (planned - now > WINDOW_MAX_MS) {
        const opens = new Date(planned - WINDOW_MAX_MS + 60 * 60_000);
        await rt.save((x) => {
          x.state = 'queued';
          x.nextRunAt = opens.toISOString();
          x.delayNote = 'Aguardando a janela de 29 dias do agendamento nativo de Reels.';
        });
        return;
      }
      if (planned - now < WINDOW_MIN_MS + SAFETY_MS) {
        throw new LateError('Menos de 20 minutos para o horário: fora da janela segura de agendamento nativo do Facebook.');
      }
    }
    if (queueMode && now < planned - 30 * 60_000 && !t.remoteId) {
      // Fila do app: só envia perto do horário.
      await rt.save((x) => {
        x.state = 'queued';
        x.nextRunAt = new Date(planned - 30 * 60_000).toISOString();
      });
      return;
    }

    const page = this.page(rt);
    await rt.save((x) => {
      x.state = 'processing';
      x.delayNote = undefined;
    });

    if (!t.remoteId) {
      const r = await graph(this.ctx, `/${page.pageId}/video_reels`, {
        method: 'POST',
        token: page.token,
        params: { upload_phase: 'start' },
        what: 'Início do upload do Reel',
      });
      await rt.save((x) => {
        x.remoteId = r.video_id;
        x.remote.uploadUrl = r.upload_url;
        x.phase = 'upload';
      });
      await rt.note(`Upload do Reel iniciado (vídeo ${r.video_id}).`);
    }

    if (rt.task.phase === 'upload') await this.upload(rt, page.token);
    if (rt.task.phase === 'uploaded') await this.finish(rt, page.token, page.pageId);
    if (rt.task.phase === 'finished') await this.confirm(rt, page.token);
  }

  private async upload(rt: TaskRuntime, token: string) {
    const m = rt.media();
    // Retomada: a Meta informa quantos bytes já recebeu.
    let offset = 0;
    try {
      const st = await this.status(rt, token);
      offset = Number(st.uploading_phase?.bytes_transferred ?? 0);
      if (st.uploading_phase?.status === 'complete') offset = m.size;
    } catch {
      offset = 0;
    }
    if (offset < m.size) {
      const url = `https://rupload.facebook.com/video-upload/${this.ctx.config.meta.graphVersion}/${rt.task.remoteId}`;
      const res = await request(url, {
        method: 'POST',
        fetchImpl: this.ctx.fetch,
        timeoutMs: 6 * 3600_000,
        duplex: 'half',
        headers: {
          Authorization: `OAuth ${token}`,
          offset: String(offset),
          file_size: String(m.size),
          'Content-Type': 'application/octet-stream',
        },
        body: await openMedia(this.ctx, rt.mc, m, { start: offset }) as any,
      });
      if (res.status !== 200 || !res.json?.success) throw metaError(res, 'Upload do Reel');
    }
    await rt.save((x) => {
      x.phase = 'uploaded';
      x.videoUploaded = true;
    });
    await rt.note('Vídeo recebido pela Meta.');
  }

  private async finish(rt: TaskRuntime, token: string, pageId: string) {
    const t = rt.task;
    const st = await this.status(rt, token);
    if (st.uploading_phase && st.uploading_phase.status !== 'complete') {
      throw new RetryableError('A Meta ainda está recebendo o vídeo.', 30_000);
    }
    const queueMode = !!t.remote.queueFallback;
    if (queueMode && rt.now() < new Date(t.plannedAt)) {
      await rt.save((x) => (x.nextRunAt = x.plannedAt));
      return;
    }
    const params: Record<string, any> = {
      upload_phase: 'finish',
      video_id: t.remoteId,
      title: t.title || undefined,
      description: t.description,
      video_state: queueMode ? 'PUBLISHED' : 'SCHEDULED',
    };
    if (!queueMode) params.scheduled_publish_time = Math.floor(new Date(t.plannedAt).getTime() / 1000);
    try {
      await graph(this.ctx, `/${pageId}/video_reels`, { method: 'POST', token, params, mayCreate: true, what: 'Finalização do Reel' });
    } catch (err: any) {
      const schedulingRejected = err instanceof PermanentError && /schedul/i.test(err.message);
      if (schedulingRejected && !queueMode) {
        if (!this.ctx.config.meta.allowDirectPublishFallback) {
          throw new PermanentError(
            `A Página não aceitou o agendamento nativo (${err.message}). Ative META_ALLOW_DIRECT_PUBLISH_FALLBACK para publicar pela fila do app no horário.`,
          );
        }
        await rt.save((x) => {
          x.remote.queueFallback = true;
          x.state = 'queued';
          x.nextRunAt = x.plannedAt;
          x.delayNote = 'Página sem agendamento nativo: o app publicará no horário (requer o Node ligado).';
        });
        await rt.note('Agendamento nativo recusado; usando a fila do app com publicação direta no horário.');
        return;
      }
      throw err;
    }
    await rt.save((x) => (x.phase = 'finished'));
  }

  private async confirm(rt: TaskRuntime, token: string) {
    const st = await this.status(rt, token);
    const ps = st.publishing_phase?.publish_status;
    if (ps === 'error' || st.video_status === 'error') {
      throw new PermanentError(`A Meta rejeitou o Reel: ${JSON.stringify(st.processing_phase?.error ?? st.publishing_phase?.error ?? 'erro de processamento')}`);
    }
    if (ps === 'published') {
      await rt.save((x) => {
        x.state = 'published';
        x.phase = 'done';
        x.effectiveAt = rt.now().toISOString();
        x.remoteUrl = `https://www.facebook.com/reel/${x.remoteId}`;
        x.nextRunAt = undefined;
      });
      await rt.note('Publicação confirmada pela Meta.');
      return;
    }
    if (ps === 'scheduled') {
      await rt.save((x) => {
        x.state = 'scheduled_remote';
        x.nativeSchedule = true;
        x.phase = 'scheduled';
        x.lastError = undefined;
        x.nextRunAt = x.plannedAt;
        x.remoteUrl = `https://www.facebook.com/reel/${x.remoteId}`;
      });
      await rt.note(`Agendamento nativo confirmado pela Meta (publish_status=scheduled${st.publishing_phase?.publish_time ? `, ${st.publishing_phase.publish_time}` : ''}).`);
      await this.applyCover(rt, token);
      return;
    }
    await rt.save((x) => (x.nextRunAt = addMinutes(rt.now(), 1).toISOString()));
  }

  private async applyCover(rt: TaskRuntime, token: string) {
    const cover = rt.cover();
    if (!cover) return rt.save((x) => (x.cover = { state: 'none' })).then(() => undefined);
    if (!this.ctx.config.meta.reelsCustomCover) {
      await rt.save((x) => (x.cover = { state: 'manual', message: 'Capa personalizada de Reels não habilitada: aplique a imagem manualmente no Meta Business Suite.' }));
      return;
    }
    const fd = new FormData();
    fd.set('access_token', token);
    fd.set('is_preferred', 'true');
    fd.set('source', new Blob([new Uint8Array(await readMedia(this.ctx, rt.mc, cover))], { type: cover.mime }), 'capa');
    const res = await request(`https://graph.facebook.com/${this.ctx.config.meta.graphVersion}/${rt.task.remoteId}/thumbnails`, {
      method: 'POST',
      fetchImpl: this.ctx.fetch,
      body: fd,
    });
    await rt.save((x) =>
      (x.cover =
        res.status === 200 && !res.json?.error
          ? { state: 'applied', message: 'Capa enviada com /{video-id}/thumbnails.' }
          : { state: 'failed', message: `O Reel foi enviado e agendado, mas a capa precisa de atenção: ${res.json?.error?.message ?? res.status}` }),
    );
  }

  private async afterScheduled(rt: TaskRuntime) {
    if (rt.now() < new Date(rt.task.plannedAt)) {
      await rt.save((x) => (x.nextRunAt = x.plannedAt));
      return;
    }
    const page = this.page(rt);
    const st = await this.status(rt, page.token);
    if (st.publishing_phase?.publish_status === 'published') {
      await rt.save((x) => {
        x.state = 'published';
        x.effectiveAt = st.publishing_phase?.publish_time ? new Date(st.publishing_phase.publish_time).toISOString() : x.plannedAt;
        x.nextRunAt = undefined;
      });
      await rt.note('Publicação confirmada pela Meta.');
      return;
    }
    await rt.save((x) => (x.nextRunAt = addMinutes(rt.now(), 5).toISOString()));
  }

  async reconcile(rt: TaskRuntime): Promise<void> {
    // Sem video_id: o "start" não publica nada; repetir é seguro.
    // Com video_id: o status remoto diz se o finish já foi aceito.
    if (rt.task.remoteId && rt.task.phase === 'uploaded') {
      const page = this.page(rt);
      const st = await this.status(rt, page.token);
      const ps = st.publishing_phase?.publish_status;
      if (ps === 'scheduled' || ps === 'published') {
        await rt.save((x) => (x.phase = 'finished'));
        await rt.note('Reconciliação: a Meta já tinha recebido a finalização. Nada será reenviado.');
      }
    }
    await rt.save((x) => (x.remote.needsReconcile = false));
    return this.run(rt);
  }

  async cancelRemote(rt: TaskRuntime): Promise<void> {
    if (!rt.task.remoteId) return;
    const page = this.page(rt);
    const r = await graph(this.ctx, `/${rt.task.remoteId}`, { method: 'DELETE', token: page.token, what: 'Cancelamento do Reel' });
    if (r?.success !== true) throw new RetryableError('A Meta não confirmou o cancelamento.');
    await rt.note('Reel agendado excluído na Meta.');
  }
  // Sem updateRemote: alterar um Reel agendado = cancelar na Meta e reenviar (feito pela rota).
}
