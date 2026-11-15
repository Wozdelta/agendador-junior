// Persistência das coleções (lotes, tarefas, mídia, conexões...).
// - Local: um arquivo JSON por coleção, gravação atômica, mutex no processo.
// - Vercel: Upstash Redis, um registro por chave, gravação com compare-and-set
//   (script Lua atômico). Várias instâncias podem alterar ao mesmo tempo: em caso
//   de conflito a alteração é reaplicada sobre o estado mais novo.
import path from 'node:path';
import { Mutex } from './mutex.js';
import { readJson, writeJsonAtomic } from './atomic.js';
import { COMMIT_SCRIPT, type RedisRest } from './redis.js';

type Rec = { id: string };
/** Estado vazio por requisição, sem fingir persistência em /tmp da Vercel. */
export class MemoryBackend<T extends Rec> implements CollectionBackend<T> {
  private items: T[] = [];
  async load() { return { items: structuredClone(this.items), versions: new Map<string, number>(), rev: 'memory' }; }
  async commit(_prev: T[], next: T[]) {
    this.items = structuredClone(next);
    return { ok: true as const, rev: 'memory', versions: new Map<string, number>() };
  }
}
interface Loaded<T> {
  items: T[];
  versions: Map<string, number>;
  rev: string;
}

export interface CollectionBackend<T extends Rec> {
  /** Devolve o estado atual, ou null se nada mudou desde `rev`. */
  load(rev: string | null): Promise<Loaded<T> | null>;
  /** Grava a diferença entre prev e next. ok=false indica conflito com outra instância. */
  commit(prev: T[], next: T[], versions: Map<string, number>, rev?: string | null): Promise<{ ok: true; rev: string; versions: Map<string, number> } | { ok: false }>;
}

export class FileBackend<T extends Rec> implements CollectionBackend<T> {
  constructor(private file: string) {}
  async load(rev: string | null): Promise<Loaded<T> | null> {
    if (rev !== null) return null; // no processo local, a memória é a fonte da verdade
    return { items: await readJson<T[]>(this.file, []), versions: new Map(), rev: 'file' };
  }
  async commit(_prev: T[], next: T[]) {
    await writeJsonAtomic(this.file, next);
    return { ok: true as const, rev: 'file', versions: new Map<string, number>() };
  }
}

export class RedisBackend<T extends Rec> implements CollectionBackend<T> {
  constructor(private redis: RedisRest, private key: string) {}
  private rk = (id: string) => `${this.key}:r:${id}`;
  private vk = (id: string) => `${this.key}:v:${id}`;

  async load(rev: string | null): Promise<Loaded<T> | null> {
    const current = String((await this.redis.cmd<string | null>('GET', `${this.key}:rev`)) ?? '0');
    if (rev !== null && rev === current) return null;
    const ids: string[] = (await this.redis.cmd<string[]>('SMEMBERS', `${this.key}:ids`)) ?? [];
    const items: T[] = [];
    const versions = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const [recs, vers] = await this.redis.pipeline([
        ['MGET', ...chunk.map(this.rk)],
        ['MGET', ...chunk.map(this.vk)],
      ]);
      chunk.forEach((id, k) => {
        if (recs[k] === null || recs[k] === undefined) return;
        items.push(JSON.parse(recs[k]));
        versions.set(id, Number(vers[k] ?? 0));
      });
    }
    const latest = String((await this.redis.cmd('GET', `${this.key}:rev`)) ?? '0');
    if (latest !== current) return this.load(null);
    items.sort((a, b) => a.id.localeCompare(b.id));
    return { items, versions, rev: current };
  }

  async commit(prev: T[], next: T[], versions: Map<string, number>, rev?: string | null) {
    const before = new Map(prev.map((x) => [x.id, JSON.stringify(x)]));
    const after = new Map(next.map((x) => [x.id, JSON.stringify(x)]));
    const ops: Array<{ type: 'put' | 'del'; id: string; value: string }> = [];
    for (const [id, v] of after) if (before.get(id) !== v) ops.push({ type: 'put', id, value: v });
    for (const id of before.keys()) if (!after.has(id)) ops.push({ type: 'del', id, value: '' });
    if (ops.length === 0) return { ok: true as const, rev: '', versions };
    const keys = [`${this.key}:rev`, `${this.key}:ids`, ...ops.flatMap((o) => [this.rk(o.id), this.vk(o.id)])];
    const argv = [String(ops.length), ...ops.flatMap((o) => [o.type, o.id, String(versions.get(o.id) ?? 0), o.value]), rev ?? '0'];
    const r = Number(await this.redis.cmd('EVAL', COMMIT_SCRIPT, keys.length, ...keys, ...argv));
    if (r < 0) return { ok: false as const };
    const nv = new Map(versions);
    for (const o of ops) o.type === 'put' ? nv.set(o.id, (versions.get(o.id) ?? 0) + 1) : nv.delete(o.id);
    return { ok: true as const, rev: String(r), versions: nv };
  }
}

export class ConflictError extends Error {}

export class JsonCollection<T extends Rec> {
  private items: T[] = [];
  private versions = new Map<string, number>();
  private rev: string | null = null;
  private mutex = new Mutex();
  constructor(private backend: CollectionBackend<T>) {}

  async load(): Promise<this> {
    await this.refresh();
    return this;
  }
  /** Atualiza a cópia em memória se outra instância gravou algo. */
  async refresh(force = false): Promise<void> {
    const r = await this.backend.load(force ? null : this.rev);
    if (!r) return;
    this.items = r.items;
    this.versions = r.versions;
    this.rev = r.rev;
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
  /** Aplica fn sobre o estado mais recente e grava; repete em caso de conflito. */
  mutate<R>(fn: (draft: T[]) => R | Promise<R>): Promise<R> {
    return this.mutex.run(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        await this.refresh(attempt > 0);
        const draft = structuredClone(this.items);
        const result = await fn(draft);
        const c = await this.backend.commit(this.items, draft, this.versions, this.rev);
        if (c.ok) {
          this.items = draft;
          this.versions = c.versions;
          if (c.rev) this.rev = c.rev;
          return structuredClone(result);
        }
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * (attempt + 1)));
      }
      throw new ConflictError('Muitas alterações simultâneas; tente de novo.');
    });
  }
  update(id: string, fn: (item: T) => void | Promise<void>): Promise<T> {
    return this.mutate(async (draft) => {
      const it = draft.find((x) => x.id === id);
      if (!it) throw new Error(`Registro ${id} não encontrado`);
      await fn(it);
      return it;
    });
  }
}

/** Documento único (objeto). Usa uma coleção de um registro com id "doc". */
export class JsonDoc<T extends object> {
  private col: JsonCollection<T & Rec>;
  constructor(backend: CollectionBackend<T & Rec>, private readonly initial: T) {
    this.col = new JsonCollection(backend);
  }
  async load(): Promise<this> {
    await this.col.load();
    return this;
  }
  refresh(force = false) {
    return this.col.refresh(force);
  }
  get(): T {
    const d = this.col.get('doc');
    const { id: _id, ...rest } = (d ?? {}) as any;
    return { ...structuredClone(this.initial), ...rest } as T;
  }
  mutate<R>(fn: (draft: T) => R | Promise<R>): Promise<R> {
    return this.col.mutate(async (items) => {
      let d = items.find((x) => x.id === 'doc');
      if (!d) {
        d = { ...structuredClone(this.initial), id: 'doc' } as T & Rec;
        items.push(d);
      }
      return fn(d);
    });
  }
}

/** Documento local: mantém o formato de arquivo antigo (objeto, sem "id"). */
export class FileDocBackend<T extends object> implements CollectionBackend<T & Rec> {
  constructor(private file: string) {}
  async load(rev: string | null) {
    if (rev !== null) return null;
    const obj = await readJson<any>(this.file, null);
    return { items: obj ? [{ ...obj, id: 'doc' }] : [], versions: new Map<string, number>(), rev: 'file' };
  }
  async commit(_prev: (T & Rec)[], next: (T & Rec)[]) {
    const d = next.find((x) => x.id === 'doc');
    const { id: _id, ...rest } = (d ?? {}) as any;
    await writeJsonAtomic(this.file, rest);
    return { ok: true as const, rev: 'file', versions: new Map<string, number>() };
  }
}

export function dataFile(dir: string, name: string): string {
  return path.join(dir, name);
}
