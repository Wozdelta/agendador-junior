import path from 'node:path';
import type { AppContext, ModeContext } from '../context.js';
import type { MediaRecord, Task } from '../domain/model.js';
import type { ConnectionDTO, Platform } from '../shared/types.js';

/** Acesso de um conector à tarefa em execução. Toda alteração é persistida na hora. */
export class TaskRuntime {
  constructor(
    public readonly ctx: AppContext,
    public readonly mc: ModeContext,
    private snapshot: Task,
  ) {}
  get task(): Task {
    return this.snapshot;
  }
  now(): Date {
    return this.ctx.clock.now();
  }
  async save(fn: (t: Task) => void): Promise<Task> {
    const now = this.now().toISOString();
    this.snapshot = await this.mc.tasks.update(this.snapshot.id, (t) => {
      fn(t);
      t.updatedAt = now;
    });
    return this.snapshot;
  }
  async note(message: string): Promise<void> {
    await this.save((t) => addHistory(t, message, this.now()));
  }
  media(): MediaRecord {
    const m = this.mc.media.get(this.snapshot.mediaId);
    if (!m) throw new Error('Arquivo de vídeo não encontrado no armazenamento local.');
    return m;
  }
  mediaPath(m: MediaRecord = this.media()): string {
    return path.join(this.mc.mediaDir, m.internalName);
  }
  cover(): MediaRecord | undefined {
    return this.snapshot.coverId ? this.mc.media.get(this.snapshot.coverId) : undefined;
  }
}

export function addHistory(t: Task, message: string, now: Date): void {
  t.history.push({ at: now.toISOString(), message });
  if (t.history.length > 60) t.history.splice(0, t.history.length - 60);
}

export interface AccountChoice {
  accountId: string;
  accountName: string;
  /** native = agendamento nativo; queue = fila do app; manual; inbox = caixa do TikTok; direct = Direct Post */
  strategy: 'native' | 'queue' | 'manual' | 'inbox' | 'direct';
}

export interface PlatformAdapter {
  platform: Platform;
  /** Avança a tarefa. Precisa ser idempotente: consulta task.phase/remote antes de cada pedido. */
  run(rt: TaskRuntime): Promise<void>;
  /** Chamado quando um envio foi interrompido (reinício/timeout) para verificar o resultado remoto. */
  reconcile(rt: TaskRuntime): Promise<void>;
  /** Cancela na plataforma. Só retorna depois da confirmação remota. */
  cancelRemote(rt: TaskRuntime): Promise<void>;
  /** Altera texto/horário de um agendamento nativo, confirmando com a plataforma. */
  updateRemote?(rt: TaskRuntime, changes: { title?: string; description?: string; plannedAt?: string }): Promise<void>;
  /** Conta de destino e estratégia; lança AppError se a conexão não permitir. */
  account(mc: ModeContext): AccountChoice;
  connection(mc: ModeContext): Promise<ConnectionDTO>;
}
