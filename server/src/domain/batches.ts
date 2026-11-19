import { deleteMediaObject } from '../lib/mediaio.js';
import { cloudPublicationQueue, TIKTOK_MAINTENANCE, TIKTOK_MAINTENANCE_MESSAGE } from '../lib/publication-execution.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppContext, ModeContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import type { Links } from '../lib/links.js';
import { newId } from '../lib/ids.js';
import { computeSchedule, formatLocal, isoToBrDate, parseBrDate } from '../lib/time.js';
import { adapterFor } from '../platforms/index.js';
import type { AccountChoice } from '../platforms/types.js';
import { validatePlatform } from '../shared/limits.js';
import {
  PLATFORMS,
  type BatchDTO,
  type BatchSummary,
  type Issue,
  type MediaInfo,
  type Platform,
  type PlatformTexts,
} from '../shared/types.js';
import { emptyTexts, type Batch, type BatchItem, type MediaRecord, type Task } from './model.js';

export function mediaInfo(m?: MediaRecord, links?: Links): MediaInfo | undefined {
  if (!m) return undefined;
  const { internalName: _i, createdAt: _c, ...info } = m;
  return links ? { ...info, url: links.media(m.id) } : info;
}

export function toBatchDTO(mc: ModeContext, b: Batch, links: Links): BatchDTO {
  return {
    id: b.id,
    mode: b.mode,
    status: b.status,
    startDate: isoToBrDate(b.startDate),
    timezone: b.timezone,
    publishTime: b.publishTime,
    platforms: b.platforms,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    confirmedAt: b.confirmedAt,
    items: b.items.map((it) => ({
      id: it.id,
      order: it.order,
      uploadStatus: it.uploadStatus,
      uploadError: it.uploadError,
      originalName: it.originalName,
      media: mediaInfo(it.mediaId ? mc.media.get(it.mediaId) : undefined, links),
      cover: mediaInfo(it.coverId ? mc.media.get(it.coverId) : undefined, links),
      uploadUrl: links.upload(b.id, it.id, 'video'),
      coverUploadUrl: links.upload(b.id, it.id, 'cover'),
      coverFrameMs: it.coverFrameMs,
      scheduledAt: it.scheduledAt,
      scheduledLocal: formatLocal(it.scheduledAt, b.timezone),
      platforms: it.platforms,
    })),
  };
}

/** Recalcula ordem e datas: um vídeo por dia corrido, no horário configurado. */
export function recompute(b: Batch): void {
  const dates = computeSchedule(b.startDate, Math.max(b.items.length, 1), b.timezone, b.publishTime);
  b.items.forEach((it, i) => {
    it.order = i + 1;
    it.scheduledAt = dates[i].toISOString();
  });
}

/** Erro de formulário quando a data/hora já passou ou está perto demais. */
export function assertFuture(ctx: AppContext, b: Pick<Batch, 'startDate' | 'timezone' | 'publishTime'>, count = 1): void {
  const dates = computeSchedule(b.startDate, Math.max(count, 1), b.timezone, b.publishTime);
  const limit = ctx.clock.now().getTime() + ctx.config.minLeadMinutes * 60_000;
  const bad = dates.find((d) => d.getTime() <= limit);
  if (bad) {
    throw new AppError(
      400,
      `A data ${formatLocal(bad, b.timezone)} já passou ou está a menos de ${ctx.config.minLeadMinutes} minutos. Escolha uma data inicial futura.`,
      { field: 'startDate' },
      'past_date',
    );
  }
}

export function parseStartDate(input: unknown): string {
  const iso = typeof input === 'string' ? parseBrDate(input) : null;
  if (!iso) throw new AppError(400, 'Data inválida. Use o formato DD/MM/AAAA com uma data existente.', { field: 'startDate' }, 'invalid_date');
  return iso;
}

export async function createDraft(ctx: AppContext, startDateInput: unknown): Promise<Batch> {
  const mc = ctx.current();
  const startDate = parseStartDate(startDateInput);
  const now = ctx.clock.now().toISOString();
  const b: Batch = {
    id: newId('lote'),
    mode: mc.mode,
    status: 'draft',
    startDate,
    timezone: ctx.config.timezone,
    publishTime: ctx.config.publishTime,
    platforms: { facebook: true, youtube: true, instagram: true, tiktok: !TIKTOK_MAINTENANCE },
    items: [],
    createdAt: now,
    updatedAt: now,
  };
  assertFuture(ctx, b);
  await mc.batches.mutate((d) => {
    d.push(b);
  });
  return b;
}

export function requireDraft(b: Batch | undefined): Batch {
  if (!b) throw new AppError(404, 'Lote não encontrado.');
  if (b.status !== 'draft') throw new AppError(409, 'Este lote já foi confirmado; edite as tarefas pela Agenda.');
  return b;
}

/** Alteração serializada de um rascunho, com recálculo das datas. */
export function mutateDraft(ctx: AppContext, mc: ModeContext, id: string, fn: (b: Batch) => void | Promise<void>): Promise<Batch> {
  return ctx.batchLocks.run(id, () =>
    mc.batches.mutate(async (d) => {
      const b = requireDraft(d.find((x) => x.id === id));
      await fn(b);
      recompute(b);
      b.updatedAt = ctx.clock.now().toISOString();
      return b;
    }),
  );
}

const TEXT_FIELDS: Array<keyof PlatformTexts> = [
  'enabled',
  'title',
  'description',
  'madeForKids',
  'privacyLevel',
  'disableComment',
  'disableDuet',
  'disableStitch',
  'directPostConsent',
];

/** Aplica apenas os campos da plataforma indicada (textos nunca vazam entre redes). */
export function applyTexts(item: BatchItem, patch: Partial<Record<Platform, Partial<PlatformTexts>>>): void {
  for (const p of PLATFORMS) {
    const src = patch?.[p];
    if (!src) continue;
    for (const f of TEXT_FIELDS) {
      if (f in src) {
        const v = (src as any)[f];
        if (f === 'title' || f === 'description' || f === 'privacyLevel') {
          if (v !== null && typeof v !== 'string') throw new AppError(400, `Campo ${f} inválido.`);
        } else if (f === 'madeForKids') {
          if (v !== null && typeof v !== 'boolean') throw new AppError(400, 'Escolha "sim" ou "não" para público infantil.');
        } else if (typeof v !== 'boolean') throw new AppError(400, `Campo ${f} inválido.`);
        (item.platforms[p] as any)[f] = v;
      }
    }
  }
}

export function newItem(name: string, size?: number): BatchItem {
  return {
    id: newId('video'),
    order: 0,
    uploadStatus: 'pending',
    originalName: String(name ?? 'video').slice(0, 200),
    expectedSize: typeof size === 'number' ? size : undefined,
    coverFrameMs: 0,
    scheduledAt: new Date(0).toISOString(),
    platforms: emptyTexts(),
  };
}

export async function removeMediaFile(ctx: AppContext, mc: ModeContext, mediaId?: string): Promise<void> {
  if (!mediaId) return;
  const inUse = mc.tasks.find((t) => t.mediaId === mediaId || t.coverId === mediaId).length > 0;
  if (inUse) return;
  const m = mc.media.get(mediaId);
  if (!m) return;
  await deleteMediaObject(ctx,mc,m);
  await mc.media.mutate((d) => {
    const i = d.findIndex((x) => x.id === mediaId);
    if (i >= 0) d.splice(i, 1);
  });
}

function accountFor(ctx: AppContext, mc: ModeContext, p: Platform): AccountChoice {
  if (p === 'tiktok' && TIKTOK_MAINTENANCE) throw new AppError(422, `${TIKTOK_MAINTENANCE_MESSAGE} Desmarque o TikTok no lote.`);
  if (ctx.config.runtime === 'vercel' && p === 'instagram' && !cloudPublicationQueue(ctx)) return { accountId: 'manual', accountName: 'Publicação manual na plataforma', strategy: 'manual' };
  return adapterFor(ctx, mc.mode, p).account(mc);
}

function accountsFor(ctx: AppContext, mc: ModeContext, b: Batch) {
  const out: Partial<Record<Platform, AccountChoice | { error: string }>> = {};
  for (const p of PLATFORMS) {
    if (!b.platforms[p]) continue;
    try {
      out[p] = accountFor(ctx, mc, p);
    } catch (err: any) {
      out[p] = { error: err.message };
    }
  }
  return out;
}

const STRATEGY_LABEL: Record<AccountChoice['strategy'], string> = {
  native: 'Agendamento nativo',
  queue: 'Fila do app (publica no horário)',
  manual: 'Ação manual',
  inbox: 'Envio à caixa de entrada',
  direct: 'Direct Post no horário',
};

export function summarize(ctx: AppContext, mc: ModeContext, b: Batch): BatchSummary {
  const issues: Issue[] = [];
  const accounts = accountsFor(ctx, mc, b);
  const enabled = PLATFORMS.filter((p) => b.platforms[p]);
  if (enabled.length === 0) issues.push({ level: 'error', message: 'Escolha pelo menos uma rede para o lote.' });
  if (b.items.length === 0) issues.push({ level: 'error', message: 'Adicione pelo menos um vídeo.' });
  try {
    assertFuture(ctx, b, b.items.length);
  } catch (err: any) {
    issues.push({ level: 'error', field: 'startDate', message: err.message });
  }
  for (const p of enabled) {
    const a = accounts[p];
    if (a && 'error' in a) issues.push({ level: 'error', platform: p, message: a.error });
  }

  const now = ctx.clock.now().getTime();
  for (const it of b.items) {
    const media = it.mediaId ? mc.media.get(it.mediaId) : undefined;
    if (it.uploadStatus !== 'ready' || !media) {
      issues.push({ level: 'error', itemId: it.id, message: `Vídeo ${it.order} (${it.originalName}): o envio do arquivo ainda não terminou.` });
    }
    const active = enabled.filter((p) => it.platforms[p].enabled);
    if (active.length === 0) issues.push({ level: 'warning', itemId: it.id, message: `Vídeo ${it.order}: nenhuma rede ativa; ele será ignorado.` });
    for (const p of active) {
      for (const iss of validatePlatform(p, it.platforms[p], mediaInfo(media), it.id)) {
        issues.push({ ...iss, message: `Vídeo ${it.order} · ${iss.message}` });
      }
      const acc = accounts[p];
      const strategy = acc && !('error' in acc) ? acc.strategy : undefined;
      if(p==='tiktok'&&ctx.config.runtime==='vercel'&&(strategy==='direct'||strategy==='inbox')&&!cloudPublicationQueue(ctx)) {
        issues.push({level:'error',platform:p,itemId:it.id,message:`Vídeo ${it.order} · TikTok: a API está autorizada, mas o executor de agendamento na nuvem não está configurado. Configure PUBLICATION_SCHEDULER_ENABLED e a chamada periódica do executor antes de agendar.`});
      }
      if (p === 'facebook' && strategy === 'native' && new Date(it.scheduledAt).getTime() - now > 29 * 86400_000) {
        issues.push({ level: 'info', platform: p, itemId: it.id, message: ctx.config.runtime === 'vercel' ? cloudPublicationQueue(ctx)?`Vídeo ${it.order} · Facebook: o executor retoma a preparação quando entrar na janela nativa.`:`Vídeo ${it.order} · Facebook: retome a preparação manualmente quando entrar na janela nativa ou publique diretamente na plataforma.` : `Vídeo ${it.order} · Facebook: fica na fila local até entrar na janela nativa.` });
      }
      if (p === 'tiktok' && strategy === 'direct' && (!it.platforms.tiktok.directPostConsent || !it.platforms.tiktok.privacyLevel)) {
        issues.push({ level: 'error', platform: p, itemId: it.id, message: `Vídeo ${it.order} · TikTok: escolha a privacidade e confirme o consentimento do Direct Post.` });
      }
      if (it.coverId && p === 'facebook' && !(ctx.config.meta.reelsCustomCover || mc.mode === 'demo')) {
        issues.push({ level: 'info', platform: p, itemId: it.id, message: `Vídeo ${it.order} · Facebook: a capa ficará disponível para aplicação manual.` });
      }
    }
  }
  if (enabled.includes('instagram')) {
    issues.push({ level: 'info', platform: 'instagram', message: ctx.config.runtime === 'vercel' ? (cloudPublicationQueue(ctx) ? 'Instagram: o executor na nuvem publica automaticamente no horário planejado.' : 'Instagram: publique manualmente no horário planejado. Ative PUBLICATION_SCHEDULER_ENABLED para publicar automaticamente.') : 'Instagram: a publicação acontece pela fila local às 12:00.' });
  }
  if (enabled.includes('tiktok')) {
    const a = accounts.tiktok;
    if (a && !('error' in a) && a.strategy === 'manual') {
      issues.push({ level: 'info', platform: 'tiktok', message: 'TikTok: publicação manual. A agenda mostrará "Ação manual necessária" com a descrição para copiar.' });
    }
  }
  return {
    batchId: b.id,
    canConfirm: !issues.some((i) => i.level === 'error'),
    issues,
    rows: b.items.map((it) => ({
      itemId: it.id,
      order: it.order,
      originalName: it.originalName,
      scheduledLocal: formatLocal(it.scheduledAt, b.timezone),
      platforms: enabled
        .filter((p) => it.platforms[p].enabled)
        .map((p) => {
          const a = accounts[p];
          return a && !('error' in a)
            ? { platform: p, account: a.accountName, mode: STRATEGY_LABEL[a.strategy] }
            : { platform: p, account: null, mode: 'Sem conta' };
        }),
    })),
  };
}

/** ID determinístico: confirmar duas vezes nunca cria tarefas duplicadas. */
export function taskId(batchId: string, itemId: string, platform: Platform, accountId: string): string {
  return 'tarefa_' + crypto.createHash('sha256').update(`${batchId}|${itemId}|${platform}|${accountId}`).digest('base64url').slice(0, 18);
}

export async function confirmBatch(ctx: AppContext, mc: ModeContext, batchId: string): Promise<{ batch: Batch; tasks: Task[]; alreadyConfirmed: boolean }> {
  return ctx.batchLocks.run(batchId, async () => {
    const b = mc.batches.get(batchId);
    if (!b) throw new AppError(404, 'Lote não encontrado.');
    if (b.status === 'confirmed') {
      return { batch: b, tasks: mc.tasks.find((t) => t.batchId === batchId), alreadyConfirmed: true };
    }
    // Validação no servidor, inclusive horários futuros, antes de registrar qualquer envio.
    const summary = summarize(ctx, mc, b);
    if (!summary.canConfirm) {
      throw new AppError(422, 'O lote tem pendências. Corrija os itens destacados.', summary.issues.filter((i) => i.level === 'error'));
    }
    const nowIso = ctx.clock.now().toISOString();
    const created: Task[] = [];
    for (const it of b.items) {
      const media = mc.media.get(it.mediaId!)!;
      for (const p of PLATFORMS) {
        if (!b.platforms[p] || !it.platforms[p].enabled) continue;
        const acc = accountFor(ctx, mc, p);
        const texts = it.platforms[p];
        const manual = acc.strategy === 'manual';
        created.push({
          id: taskId(b.id, it.id, p, acc.accountId),
          mode: mc.mode,
          batchId: b.id,
          itemId: it.id,
          platform: p,
          accountId: acc.accountId,
          accountName: acc.accountName,
          state: manual ? 'manual_action' : 'queued',
          manualReason: manual ? (p === 'tiktok' ? 'tiktok_manual' : 'platform_manual') : undefined,
          plannedAt: it.scheduledAt,
          attempts: 0,
          nextRunAt: manual ? undefined : nowIso,
          phase: '',
          remote: { strategy: acc.strategy },
          nativeSchedule: false,
          cover: { state: it.coverId ? 'pending' : 'none' },
          videoUploaded: false,
          originalName: it.originalName,
          mediaId: media.id,
          coverId: it.coverId,
          coverFrameMs: it.coverFrameMs,
          title: texts.title,
          description: texts.description,
          options: {
            madeForKids: texts.madeForKids,
            privacyLevel: texts.privacyLevel,
            disableComment: texts.disableComment,
            disableDuet: texts.disableDuet,
            disableStitch: texts.disableStitch,
            directPostConsent: texts.directPostConsent,
          },
          history: [{ at: nowIso, message: `Tarefa registrada (${STRATEGY_LABEL[acc.strategy]}).` }],
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }
    // 1) grava as tarefas (upsert por ID determinístico); 2) marca o lote como confirmado.
    await mc.tasks.mutate((d) => {
      for (const t of created) if (!d.some((x) => x.id === t.id)) d.push(t);
    });
    const batch = await mc.batches.update(batchId, (x) => {
      x.status = 'confirmed';
      x.confirmedAt = nowIso;
      x.updatedAt = nowIso;
    });
    return { batch, tasks: mc.tasks.find((t) => t.batchId === batchId), alreadyConfirmed: false };
  });
}
