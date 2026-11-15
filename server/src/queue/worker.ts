// Fila persistente no backend. Roda com a aba fechada; a cada inicialização
// recupera tarefas interrompidas e reconcilia pelo ID remoto.
import type { AppContext, ModeContext } from '../context.js';
import type { Task } from '../domain/model.js';
import { AuthError, LateError, ManualReviewError, PermanentError, RetryableError, UnknownOutcomeError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { addMinutes } from '../lib/time.js';
import { adapterFor } from '../platforms/index.js';
import { addHistory, TaskRuntime } from '../platforms/types.js';
import type { AppMode, Platform } from '../shared/types.js';

const RUNNABLE = new Set(['queued', 'processing', 'scheduled_remote', 'manual_action']);

/** Espera exponencial limitada com variação aleatória. */
export function backoffMs(attempt: number): number {
  const base = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private busyPlatforms = new Set<string>();
  private ticking = false;

  constructor(private ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error('Falha no ciclo da fila:', err));
    }, this.ctx.config.workerTickMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Recupera tarefas que estavam travadas por outra execução do backend. */
  async recover(): Promise<number> {
    let n = 0;
    for (const mc of Object.values(this.ctx.modes)) {
      const now = this.ctx.clock.now();
      n += await mc.tasks.mutate((d) => {
        let c = 0;
        for (const t of d) {
          if (t.lock && (this.ctx.config.storage === 'file' ? t.lock.bootId !== this.ctx.bootId : new Date(t.lock.until ?? t.lock.at).getTime() <= now.getTime())) {
            t.lock = undefined;
            t.remote.needsReconcile = true;
            t.nextRunAt = now.toISOString();
            addHistory(t, 'O backend reiniciou durante um envio; verificando o resultado remoto antes de continuar.', now);
            c++;
          }
        }
        return c;
      });
    }
    if (n) log.info(`Fila: ${n} tarefa(s) interrompida(s) serão reconciliadas.`);
    return n;
  }

  private isDue(t: Task, now: Date): boolean {
    if (!this.eligible(t)) return false;
    if (!RUNNABLE.has(t.state)) return false;
    if (t.state === 'manual_action' && t.manualReason !== 'tiktok_inbox') return false;
    if (!t.nextRunAt) return false;
    return new Date(t.nextRunAt) <= now;
  }

  private eligible(t: Task): boolean {
    return this.ctx.config.runtime !== 'vercel' || (t.mode === 'real' && ['youtube', 'facebook'].includes(t.platform) && t.remote.strategy === 'native' && !t.remote.queueFallback);
  }

  /** Um ciclo: executa as tarefas vencidas respeitando a concorrência. Retorna quando todas terminam. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      await this.ctx.refresh(['demo', 'real']);
      const jobs: Promise<void>[] = [];
      for (const mc of Object.values(this.ctx.modes)) {
        const now = this.ctx.clock.now();
        await this.markLate(mc, now);
        const due = mc.tasks
          .find((t) => this.isDue(t, now) && !this.running.has(t.id))
          .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
        for (const t of due) {
          if (this.running.size >= this.ctx.config.workerConcurrency) break;
          const pk = `${mc.mode}:${t.platform}`;
          if (this.busyPlatforms.has(pk)) continue; // uma tarefa por plataforma por vez
          this.running.add(t.id);
          this.busyPlatforms.add(pk);
          jobs.push(
            this.runTask(mc, t.id).finally(() => {
              this.running.delete(t.id);
              this.busyPlatforms.delete(pk);
            }),
          );
        }
      }
      await Promise.all(jobs);
      return jobs.length;
    } finally {
      this.ticking = false;
    }
  }

  /** Executa ciclos até não haver mais trabalho imediato (usado nos testes). */
  async drain(maxRounds = 20): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const now = this.ctx.clock.now();
      const pending = Object.values(this.ctx.modes).some((mc) => mc.tasks.find((t) => this.isDue(t, now)).length > 0);
      if (!pending) return;
      await this.tick();
    }
  }

  /** Itens não agendados nativamente que passaram da tolerância viram "Atrasado". */
  private async markLate(mc: ModeContext, now: Date): Promise<void> {
    const tol = this.ctx.config.lateToleranceMinutes;
    const late = mc.tasks.find(
      (t) =>
        this.eligible(t) &&
        (t.state === 'queued' || t.state === 'processing') &&
        (!t.lock || new Date(t.lock.until ?? t.lock.at) <= now) &&
        !this.running.has(t.id) &&
        addMinutes(new Date(t.plannedAt), tol) < now,
    );
    for (const t of late) {
      await mc.tasks.update(t.id, (x) => {
        if (x.lock && new Date(x.lock.until ?? x.lock.at) > now) return;
        if (!['queued', 'processing'].includes(x.state)) return;
        x.state = 'late';
        x.nextRunAt = undefined;
        x.delayNote = `Não foi possível publicar até ${tol} min após o horário planejado. Escolha uma nova data.`;
        addHistory(x, x.delayNote, now);
        x.updatedAt = now.toISOString();
      });
    }
  }

  async runTask(mc: ModeContext, id: string): Promise<void> {
    await this.ctx.taskLocks.run(id, async () => {
      const t0 = mc.tasks.get(id);
      if (!t0 || !this.eligible(t0) || !RUNNABLE.has(t0.state)) return;
      const nowIso = this.ctx.clock.now().toISOString();
      // Trava persistida: se o processo cair aqui, a próxima inicialização reconcilia.
      const locked = await mc.tasks.mutate((tasks) => {
        const t = tasks.find(x => x.id === id);
        if (!t || !this.isDue(t, new Date(nowIso))) return null;
        if (t.lock && new Date(t.lock.until ?? t.lock.at).getTime() > Date.parse(nowIso)) return null;
        if (t.lock) t.remote.needsReconcile = true;
        t.lock = { bootId: this.ctx.bootId, at: nowIso, until: new Date(Date.parse(nowIso) + this.ctx.config.taskLeaseMs).toISOString() };
        return t;
      });
      if (!locked) return;
      const rt = new TaskRuntime(this.ctx, mc, locked);
      const adapter = adapterFor(this.ctx, mc.mode as AppMode, locked.platform as Platform);
      try {
        if (locked.remote.needsReconcile) await adapter.reconcile(rt);
        else await adapter.run(rt);
        await rt.save((t) => {
          t.lock = undefined;
          if (t.state !== 'failed') t.lastError = undefined;
          if (['scheduled_remote', 'published', 'manual_action'].includes(t.state)) t.attempts = 0;
        });
      } catch (err) {
        await this.handleError(rt, err);
      }
    });
  }

  private async handleError(rt: TaskRuntime, err: unknown): Promise<void> {
    const now = this.ctx.clock.now();
    const msg = err instanceof Error ? err.message : String(err);
    const max = this.ctx.config.maxAttempts;
    log.warn(`Tarefa ${rt.task.id} (${rt.task.platform}): ${msg}`);
    await rt.save((t) => {
      t.lock = undefined;
      t.lastError = msg;
      if (err instanceof LateError) {
        t.state = 'late';
        t.nextRunAt = undefined;
        t.delayNote = msg;
      } else if (err instanceof ManualReviewError) {
        t.state = 'manual_action';
        t.manualReason = 'review_unknown';
        t.nextRunAt = undefined;
      } else if (err instanceof AuthError) {
        t.state = 'failed';
        t.nextRunAt = undefined;
      } else if (err instanceof UnknownOutcomeError) {
        t.attempts += 1;
        t.remote.needsReconcile = true;
        if (t.attempts >= max) {
          t.state = 'manual_action';
          t.manualReason = 'review_unknown';
          t.nextRunAt = undefined;
        } else {
          t.nextRunAt = new Date(now.getTime() + backoffMs(t.attempts)).toISOString();
        }
      } else if (err instanceof RetryableError) {
        // Limites de cota/canal não consomem tentativas: são esperas programadas.
        if (err.kind !== 'quota') t.attempts += 1;
        if (t.attempts >= max) {
          t.state = 'failed';
          t.nextRunAt = undefined;
        } else {
          const wait = Math.max(err.retryAfterMs ?? 0, backoffMs(t.attempts));
          t.nextRunAt = new Date(now.getTime() + wait).toISOString();
        }
      } else {
        // PermanentError ou erro inesperado
        t.state = 'failed';
        t.nextRunAt = undefined;
        if (!(err instanceof PermanentError)) log.error(err);
      }
      addHistory(t, `${t.state === 'failed' ? 'Falha' : 'Aviso'}: ${msg}`, now);
    });
  }
}
