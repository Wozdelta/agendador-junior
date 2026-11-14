import type { AppContext, ModeContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import type { Links } from '../lib/links.js';
import { computeSchedule, formatLocal, parseBrDate, parseTime } from '../lib/time.js';
import { adapterFor } from '../platforms/index.js';
import { addHistory, TaskRuntime } from '../platforms/types.js';
import { validatePlatform } from '../shared/limits.js';
import type { TaskAction, TaskDTO } from '../shared/types.js';
import type { Task } from './model.js';
import { mediaInfo } from './batches.js';

export function actionsFor(t: Task): TaskAction[] {
  switch (t.state) {
    case 'queued':
      return ['edit', 'reschedule', 'cancel'];
    case 'processing':
      return ['cancel'];
    case 'scheduled_remote':
      return ['edit', 'reschedule', 'cancel'];
    case 'late':
      return ['reschedule', 'cancel'];
    case 'failed':
      return ['retry', 'edit', 'reschedule', 'cancel'];
    case 'manual_action':
      return t.manualReason === 'review_unknown' ? ['resolve_review', 'cancel'] : ['manual_complete', 'edit', 'reschedule', 'cancel'];
    default:
      return [];
  }
}

export function toTaskDTO(ctx: AppContext, mc: ModeContext, t: Task, links: Links): TaskDTO {
  const tz = ctx.config.timezone;
  return {
    id: t.id,
    mode: t.mode,
    batchId: t.batchId,
    itemId: t.itemId,
    platform: t.platform,
    accountId: t.accountId,
    accountName: t.accountName,
    state: t.state,
    manualReason: t.manualReason,
    plannedAt: t.plannedAt,
    plannedLocal: formatLocal(t.plannedAt, tz),
    effectiveAt: t.effectiveAt,
    effectiveLocal: t.effectiveAt ? formatLocal(t.effectiveAt, tz) : undefined,
    attempts: t.attempts,
    nextRunAt: t.nextRunAt,
    lastError: t.lastError,
    delayNote: t.delayNote,
    remoteId: t.remoteId,
    remoteUrl: t.remoteUrl,
    nativeSchedule: t.nativeSchedule,
    publishedManually: t.publishedManually,
    cover: t.cover,
    videoUploaded: t.videoUploaded,
    originalName: t.originalName,
    mediaId: t.mediaId,
    coverId: t.coverId,
    mediaUrl: t.mediaId ? links.media(t.mediaId) : undefined,
    coverUrl: t.coverId ? links.media(t.coverId) : undefined,
    title: t.title,
    description: t.description,
    history: t.history,
    actions: actionsFor(t),
  };
}

function load(mc: ModeContext, id: string): Task {
  const t = mc.tasks.get(id);
  if (!t) throw new AppError(404, 'Tarefa não encontrada.');
  return t;
}

function requireAction(t: Task, a: TaskAction) {
  if (!actionsFor(t).includes(a)) throw new AppError(409, `Ação indisponível no estado atual da tarefa.`);
}

/** Executa sob a trava da tarefa (a mesma usada pela fila), evitando corrida com um envio. */
function withTask<T>(ctx: AppContext, mc: ModeContext, id: string, fn: (t: Task) => Promise<T>): Promise<T> {
  return ctx.taskLocks.run(id, () => fn(load(mc, id)));
}

async function patch(ctx: AppContext, mc: ModeContext, id: string, fn: (t: Task) => void, message?: string) {
  const now = ctx.clock.now();
  return mc.tasks.update(id, (t) => {
    fn(t);
    if (message) addHistory(t, message, now);
    t.updatedAt = now.toISOString();
  });
}

export function cancelTask(ctx: AppContext, mc: ModeContext, id: string): Promise<Task> {
  return withTask(ctx, mc, id, async (t) => {
    requireAction(t, 'cancel');
    if (t.state === 'scheduled_remote' || t.videoUploaded || t.remoteId) {
      // Agendamento nativo: só mostra "Cancelado" depois da confirmação da plataforma.
      const rt = new TaskRuntime(ctx, mc, t);
      try {
        await adapterFor(ctx, mc.mode, t.platform).cancelRemote(rt);
      } catch (err: any) {
        if (err instanceof AppError) throw err;
        throw new AppError(502, `A plataforma não confirmou o cancelamento: ${err.message}`);
      }
    }
    return patch(ctx, mc, id, (x) => {
      x.state = 'cancelled';
      x.nextRunAt = undefined;
    }, 'Cancelado pelo usuário.');
  });
}

export function retryTask(ctx: AppContext, mc: ModeContext, id: string): Promise<Task> {
  return withTask(ctx, mc, id, async (t) => {
    requireAction(t, 'retry');
    if (new Date(t.plannedAt).getTime() + ctx.config.lateToleranceMinutes * 60_000 < ctx.clock.now().getTime()) {
      throw new AppError(409, 'O horário planejado já passou. Use "Nova data" para reagendar.');
    }
    return patch(ctx, mc, id, (x) => {
      x.state = 'queued';
      x.attempts = 0;
      x.lastError = undefined;
      x.nextRunAt = ctx.clock.now().toISOString();
      // Retoma do ponto salvo; o conector verifica o estado remoto antes de reenviar.
      if (x.remoteId || x.remote.sessionUri || x.remote.containerId || x.remote.publishId) x.remote.needsReconcile = true;
    }, 'Nova tentativa solicitada.');
  });
}

function resetForResend(x: Task) {
  x.phase = '';
  x.remoteId = undefined;
  x.remoteUrl = undefined;
  x.videoUploaded = false;
  x.nativeSchedule = false;
  x.remote = { strategy: x.remote.strategy };
}

export function rescheduleTask(ctx: AppContext, mc: ModeContext, id: string, dateBr: unknown, time?: unknown): Promise<Task> {
  return withTask(ctx, mc, id, async (t) => {
    requireAction(t, 'reschedule');
    const iso = typeof dateBr === 'string' ? parseBrDate(dateBr) : null;
    if (!iso) throw new AppError(400, 'Data inválida. Use DD/MM/AAAA.', { field: 'date' });
    const hhmm = typeof time === 'string' && time ? time : ctx.config.publishTime;
    try {
      parseTime(hhmm);
    } catch {
      throw new AppError(400, 'Horário inválido. Use HH:mm.', { field: 'time' });
    }
    const [when] = computeSchedule(iso, 1, ctx.config.timezone, hhmm);
    if (when.getTime() <= ctx.clock.now().getTime() + ctx.config.minLeadMinutes * 60_000) {
      throw new AppError(400, `A nova data precisa estar no futuro (mínimo ${ctx.config.minLeadMinutes} minutos).`, { field: 'date' });
    }
    const plannedAt = when.toISOString();
    const adapter = adapterFor(ctx, mc.mode, t.platform);
    if (t.state === 'scheduled_remote') {
      const rt = new TaskRuntime(ctx, mc, t);
      if (adapter.updateRemote) {
        try {
          await adapter.updateRemote(rt, { plannedAt });
        } catch (err: any) {
          throw new AppError(502, `A plataforma não confirmou o novo horário: ${err.message}`);
        }
        return patch(ctx, mc, id, (x) => {
          x.plannedAt = plannedAt;
          x.nextRunAt = plannedAt;
        }, `Novo horário confirmado pela plataforma: ${formatLocal(plannedAt, ctx.config.timezone)}.`);
      }
      // Sem edição nativa (Facebook): cancela na plataforma e reenvia.
      try {
        await adapter.cancelRemote(rt);
      } catch (err: any) {
        throw new AppError(502, `A plataforma não confirmou o cancelamento do agendamento anterior: ${err.message}`);
      }
      return patch(ctx, mc, id, (x) => {
        resetForResend(x);
        x.plannedAt = plannedAt;
        x.state = 'queued';
        x.nextRunAt = ctx.clock.now().toISOString();
        x.attempts = 0;
        x.lastError = undefined;
        x.delayNote = undefined;
      }, `Agendamento anterior removido na plataforma; reenviando para ${formatLocal(plannedAt, ctx.config.timezone)}.`);
    }
    const manual = t.state === 'manual_action';
    return patch(ctx, mc, id, (x) => {
      if (x.state === 'late' || x.state === 'failed') {
        // Container antigo do Instagram pode expirar; recria. Upload do YouTube com publishAt antigo é refeito.
        if (x.platform === 'instagram') {
          x.remote.containerId = undefined;
          x.phase = '';
        }
        if (x.platform === 'youtube' && !x.remoteId) {
          x.remote.sessionUri = undefined;
          x.phase = '';
        }
      }
      x.plannedAt = plannedAt;
      x.state = manual ? 'manual_action' : 'queued';
      x.nextRunAt = manual ? undefined : ctx.clock.now().toISOString();
      x.attempts = 0;
      x.lastError = undefined;
      x.delayNote = undefined;
    }, `Reagendado para ${formatLocal(plannedAt, ctx.config.timezone)}.`);
  });
}

export function editTask(ctx: AppContext, mc: ModeContext, id: string, body: { title?: unknown; description?: unknown }): Promise<Task> {
  return withTask(ctx, mc, id, async (t) => {
    requireAction(t, 'edit');
    const title = typeof body.title === 'string' ? body.title : t.title;
    const description = typeof body.description === 'string' ? body.description : t.description;
    const media = mediaInfo(mc.media.get(t.mediaId));
    const errors = validatePlatform(t.platform, { enabled: true, title, description, ...t.options }, media).filter((i) => i.level === 'error');
    if (errors.length) throw new AppError(400, errors[0].message, errors);
    if (t.state === 'scheduled_remote') {
      const adapter = adapterFor(ctx, mc.mode, t.platform);
      const rt = new TaskRuntime(ctx, mc, t);
      if (adapter.updateRemote) {
        try {
          await adapter.updateRemote(rt, { title, description });
        } catch (err: any) {
          throw new AppError(502, `A plataforma não confirmou a alteração: ${err.message}`);
        }
        return patch(ctx, mc, id, (x) => {
          x.title = title;
          x.description = description;
        }, 'Texto atualizado e confirmado pela plataforma.');
      }
      try {
        await adapter.cancelRemote(rt);
      } catch (err: any) {
        throw new AppError(502, `A plataforma não confirmou a remoção do agendamento anterior: ${err.message}`);
      }
      return patch(ctx, mc, id, (x) => {
        resetForResend(x);
        x.title = title;
        x.description = description;
        x.state = 'queued';
        x.nextRunAt = ctx.clock.now().toISOString();
      }, 'Agendamento anterior removido na plataforma; reenviando com o novo texto.');
    }
    return patch(ctx, mc, id, (x) => {
      x.title = title;
      x.description = description;
      if (x.platform === 'instagram' && x.remote.containerId && x.state !== 'published') {
        x.remote.containerId = undefined; // a legenda vai no container: recria
        x.phase = '';
      }
    }, 'Texto atualizado.');
  });
}

export function manualComplete(ctx: AppContext, mc: ModeContext, id: string, url: unknown): Promise<Task> {
  return withTask(ctx, mc, id, async (t) => {
    requireAction(t, 'manual_complete');
    const link = typeof url === 'string' && url.trim() ? url.trim() : undefined;
    if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw new AppError(400, 'Cole um link https:// válido (ou deixe em branco).', { field: 'url' });
    const now = ctx.clock.now().toISOString();
    return patch(ctx, mc, id, (x) => {
      x.state = 'published';
      x.publishedManually = true;
      x.effectiveAt = now;
      x.remoteUrl = link ?? x.remoteUrl;
      x.nextRunAt = undefined;
    }, `Publicação registrada manualmente pelo usuário${link ? ` (${link})` : ''}.`);
  });
}

export function resolveReview(ctx: AppContext, mc: ModeContext, id: string, outcome: unknown, url: unknown): Promise<Task> {
  return withTask(ctx, mc, id, async (t) => {
    requireAction(t, 'resolve_review');
    if (outcome === 'published') {
      return patch(ctx, mc, id, (x) => {
        x.state = 'published';
        x.publishedManually = true;
        x.effectiveAt = ctx.clock.now().toISOString();
        if (typeof url === 'string' && url) x.remoteUrl = url;
        x.manualReason = undefined;
      }, 'Revisão manual: o usuário confirmou que a publicação existe.');
    }
    if (outcome === 'not_published') {
      return patch(ctx, mc, id, (x) => {
        resetForResend(x);
        x.manualReason = undefined;
        x.state = 'queued';
        x.attempts = 0;
        x.nextRunAt = ctx.clock.now().toISOString();
      }, 'Revisão manual: o usuário confirmou que nada foi publicado; reenviando.');
    }
    throw new AppError(400, 'Informe se a publicação foi encontrada ("published") ou não ("not_published").');
  });
}
