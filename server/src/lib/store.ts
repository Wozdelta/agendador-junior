import path from 'node:path';
import { Mutex } from './mutex.js';
import { readJson, writeJsonAtomic } from './atomic.js';

/**
 * Coleção persistida em um arquivo JSON. Todas as alterações passam por um mutex
 * (serializadas), são aplicadas numa cópia e só substituem o estado em memória
 * depois que a gravação atômica no disco termina.
 */
export class JsonCollection<T extends { id: string }> {
  private items: T[] = [];
  private mutex = new Mutex();
  constructor(public readonly file: string) {}

  async load(): Promise<this> {
    this.items = await readJson<T[]>(this.file, []);
    return this;
  }
  all(): T[] {
    return structuredClone(this.items);
  }
  get(id: string): T | undefined {
    const it = this.items.find((x) => x.id === id);
    return it ? structuredClone(it) : undefined;
  }
  find(pred: (t: T) => boolean): T[] {
    return structuredClone(this.items.filter(pred));
  }
  /** Executa fn sobre um rascunho do estado e grava atomicamente. */
  mutate<R>(fn: (draft: T[]) => R | Promise<R>): Promise<R> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.items);
      const result = await fn(draft);
      await writeJsonAtomic(this.file, draft);
      this.items = draft;
      return structuredClone(result);
    });
  }
  /** Atualiza um registro; lança se não existir. */
  update(id: string, fn: (item: T) => void | Promise<void>): Promise<T> {
    return this.mutate(async (draft) => {
      const it = draft.find((x) => x.id === id);
      if (!it) throw new Error(`Registro ${id} não encontrado`);
      await fn(it);
      return it;
    });
  }
}

/** Documento único (objeto) persistido em JSON. */
export class JsonDoc<T extends object> {
  private value: T;
  private mutex = new Mutex();
  constructor(public readonly file: string, private readonly initial: T) {
    this.value = structuredClone(initial);
  }
  async load(): Promise<this> {
    this.value = { ...structuredClone(this.initial), ...(await readJson<Partial<T>>(this.file, {})) };
    return this;
  }
  get(): T {
    return structuredClone(this.value);
  }
  mutate<R>(fn: (draft: T) => R | Promise<R>): Promise<R> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.value);
      const r = await fn(draft);
      await writeJsonAtomic(this.file, draft);
      this.value = draft;
      return structuredClone(r);
    });
  }
}

export function dataFile(dir: string, name: string): string {
  return path.join(dir, name);
}
