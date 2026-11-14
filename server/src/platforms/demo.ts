// Conectores simulados do MODO DEMONSTRAÇÃO. Não fazem nenhuma chamada de rede e
// gravam o "lado remoto" em data/demo/demo-remote.json, isolado do modo real.
import crypto from 'node:crypto';
import type { AppContext, ModeContext } from '../context.js';
import { LateError, ManualReviewError, PermanentError, RetryableError, UnknownOutcomeError } from '../lib/errors.js';
import { addMinutes } from '../lib/time.js';
import type { ConnectionDTO, Platform } from '../shared/types.js';
import type { AccountChoice, PlatformAdapter, TaskRuntime } from './types.js';

const DEMO_ACCOUNTS: Record<Platform, string> = {
  youtube: '[DEMO] Canal de Teste',
  facebook: '[DEMO] Página de Teste',
  instagram: '[DEMO] @conta_teste',
  tiktok: '[DEMO] TikTok manual',
};

const FB_WINDOW_DAYS = 29;

async function consumeFault(mc: ModeContext, platform: Platform) {
  return mc.demo.mutate((d) => {
    const f = d.faults[platform];
    if (!f || f.remaining <= 0) return null;
    f.remaining -= 1;
    return { kind: f.kind };
  });
}

export class DemoAdapter implements PlatformAdapter {
  constructor(public platform: Platform, private ctx: AppContext) {}

  account(): AccountChoice {
    const strategy = this.platform === 'tiktok' ? 'manual' : this.platform === 'instagram' ? 'queue' : 'native';
    return { accountId: `demo-${this.platform}`, accountName: DEMO_ACCOUNTS[this.platform], strategy };
  }

  async connection(): Promise<ConnectionDTO> {
    return {
      platform: this.platform,
      configured: true,
      connected: true,
      accountName: DEMO_ACCOUNTS[this.platform],
      accountId: `demo-${this.platform}`,
      capabilities:
        this.platform === 'tiktok' ? ['manual'] : this.platform === 'instagram' ? ['queue', 'cover_image', 'cover_frame'] : ['native_schedule', 'cover_image'],
      notes: ['Conta simulada do modo demonstração. Nada é enviado às plataformas.'],
    };
  }

  private findRemote(rt: TaskRuntime) {
    const r = rt.mc.demo.get().remote;
    return Object.entries(r).find(([, v]) => v.taskId === rt.task.id);
  }

  /** Simula o pedido que cria algo remotamente, incluindo falhas injetadas. */
  private async createRemote(rt: TaskRuntime, status: string, publishAt?: string): Promise<string> {
    const fault = await consumeFault(rt.mc, this.platform);
    if (fault?.kind === 'fail') throw new PermanentError('Simulação: a plataforma recusou o vídeo.');
    if (fault?.kind === 'transient') throw new RetryableError('Simulação: erro temporário (503).', 1000);
    const id = `demo_${this.platform}_${crypto.randomBytes(5).toString('hex')}`;
    if (fault?.kind === 'unverifiable') {
      throw new UnknownOutcomeError('Simulação: conexão caiu e o resultado não pode ser verificado.');
    }
    await rt.mc.demo.mutate((d) => {
      d.remote[id] = { platform: this.platform, taskId: rt.task.id, status, publishAt, createdAt: rt.now().toISOString() };
    });
    if (fault?.kind === 'timeout') throw new UnknownOutcomeError('Simulação: tempo esgotado depois do envio.');
    return id;
  }

  async run(rt: TaskRuntime): Promise<void> {
    const t = rt.task;
    const now = rt.now();
    const planned = new Date(t.plannedAt);

    if (this.platform === 'tiktok') {
      await rt.save((x) => {
        x.state = 'manual_action';
        x.manualReason = 'tiktok_manual';
        x.nextRunAt = undefined;
      });
      return;
    }

    // Já agendado: confirmar publicação depois do horário
    if (t.state === 'scheduled_remote' && t.remoteId) {
      if (now < planned) {
        await rt.save((x) => (x.nextRunAt = t.plannedAt));
        return;
      }
      await rt.mc.demo.mutate((d) => {
        if (d.remote[t.remoteId!]) d.remote[t.remoteId!].status = 'published';
      });
      await rt.save((x) => {
        x.state = 'published';
        x.effectiveAt = x.plannedAt;
        x.nextRunAt = undefined;
        x.remoteUrl = `https://exemplo.invalid/${this.platform}/${t.remoteId}`;
      });
      await rt.note('Publicação confirmada pela plataforma (simulada).');
      return;
    }

    if (this.platform === 'youtube' || this.platform === 'facebook') {
      if (planned.getTime() - now.getTime() < 10 * 60_000) {
        throw new LateError('O horário está perto demais para um agendamento nativo seguro.');
      }
      if (this.platform === 'facebook' && planned.getTime() - now.getTime() > FB_WINDOW_DAYS * 86400_000) {
        const opens = addMinutes(planned, -FB_WINDOW_DAYS * 24 * 60 + 60);
        await rt.save((x) => {
          x.state = 'queued';
          x.nextRunAt = opens.toISOString();
          x.delayNote = 'Aguardando a janela de 29 dias do agendamento nativo do Facebook.';
        });
        return;
      }
      await rt.save((x) => (x.state = 'processing'));
      const id = t.remoteId ?? (await this.createRemote(rt, 'scheduled', t.plannedAt));
      await this.markScheduled(rt, id);
      return;
    }

    // Instagram: container perto do horário, publicação na hora
    const lead = this.ctx.config.meta.igContainerLeadMinutes;
    const createAt = addMinutes(planned, -lead);
    if (!t.remote.containerId && now < createAt) {
      await rt.save((x) => {
        x.state = 'queued';
        x.nextRunAt = createAt.toISOString();
      });
      return;
    }
    if (!t.remote.containerId) {
      await rt.save((x) => (x.state = 'processing'));
      const id = await this.createRemote(rt, 'container');
      await rt.save((x) => {
        x.remote.containerId = id;
        x.videoUploaded = true;
        x.nextRunAt = addMinutes(rt.now(), 0).toISOString();
        x.cover = x.coverId ? { state: 'applied', message: 'Capa enviada (cover_url).' } : { state: 'frame', message: `Quadro em ${x.coverFrameMs} ms (thumb_offset).` };
      });
      await rt.note('Container criado e vídeo enviado (simulado).');
      return;
    }
    if (now < planned) {
      await rt.save((x) => (x.nextRunAt = x.plannedAt));
      return;
    }
    await rt.save((x) => {
      x.state = 'published';
      x.remoteId = `demo_ig_media_${x.remote.containerId.slice(-6)}`;
      x.effectiveAt = rt.now().toISOString();
      x.remoteUrl = `https://exemplo.invalid/instagram/${x.remoteId}`;
      x.nextRunAt = undefined;
    });
    await rt.note('media_publish confirmado (simulado).');
  }

  private async markScheduled(rt: TaskRuntime, id: string) {
    const cover = rt.task.coverId;
    const fbNoCover = this.platform === 'facebook' && !this.ctx.config.meta.reelsCustomCover;
    await rt.save((x) => {
      x.remoteId = id;
      x.videoUploaded = true;
      x.state = 'scheduled_remote';
      x.nativeSchedule = true;
      x.nextRunAt = x.plannedAt;
      x.remote.needsReconcile = false;
      x.cover = !cover
        ? { state: 'none' }
        : fbNoCover
          ? { state: 'manual', message: 'Capa personalizada não habilitada para Reels: use a imagem manualmente.' }
          : { state: 'applied', message: 'Capa aplicada (simulado).' };
    });
    await rt.note(`Agendamento nativo confirmado pela plataforma (simulado), ID ${id}.`);
  }

  async reconcile(rt: TaskRuntime): Promise<void> {
    const found = this.findRemote(rt);
    if (found) {
      await rt.note(`Reconciliação: o envio anterior foi encontrado na plataforma (ID ${found[0]}). Nada será reenviado.`);
      if (this.platform === 'instagram') {
        await rt.save((x) => {
          x.remote.containerId = found[0];
          x.remote.needsReconcile = false;
          x.videoUploaded = true;
        });
      } else {
        await this.markScheduled(rt, found[0]);
      }
      return;
    }
    const lostUnverifiable = rt.task.lastError?.includes('não pode ser verificado');
    if (lostUnverifiable) {
      throw new ManualReviewError('Não foi possível confirmar se a publicação foi criada. Verifique na plataforma.');
    }
    await rt.save((x) => (x.remote.needsReconcile = false));
    await rt.note('Reconciliação: nada foi criado na plataforma; o envio pode ser repetido com segurança.');
    await this.run(rt);
  }

  async cancelRemote(rt: TaskRuntime): Promise<void> {
    const id = rt.task.remoteId ?? rt.task.remote.containerId;
    if (!id) return;
    await rt.mc.demo.mutate((d) => {
      if (d.remote[id]) d.remote[id].status = 'cancelled';
    });
  }

  async updateRemote(rt: TaskRuntime, changes: { plannedAt?: string }): Promise<void> {
    const id = rt.task.remoteId;
    if (!id) return;
    await rt.mc.demo.mutate((d) => {
      if (d.remote[id] && changes.plannedAt) d.remote[id].publishAt = changes.plannedAt;
    });
  }
}
