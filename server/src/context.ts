import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import type { AppMode } from './shared/types.js';
import { FileBackend, FileDocBackend, JsonCollection, JsonDoc, RedisBackend, type CollectionBackend } from './lib/store.js';
import { RedisRest } from './lib/redis.js';
import { TokenVault } from './lib/crypto.js';
import { createFfprobe, type Prober } from './lib/media.js';
import { systemClock, type Clock } from './lib/time.js';
import type { FetchLike } from './lib/http.js';
import { KeyedMutex } from './lib/mutex.js';
import { deriveKey } from './lib/session.js';
import type { Batch, ConnectionsDoc, IdemRecord, MediaRecord, Task } from './domain/model.js';

export interface DemoFault {
  /** fail = falha definitiva; transient = falha temporária; timeout = cria remoto e perde a resposta;
   *  unverifiable = perde a resposta e não dá para confirmar o resultado. */
  kind: 'fail' | 'transient' | 'timeout' | 'unverifiable';
  remaining: number; // quantas vezes ainda dispara
}
export interface DemoDoc {
  faults: Partial<Record<string, DemoFault>>;
  remote: Record<string, { platform: string; taskId: string; status: string; publishAt?: string; createdAt: string }>;
}

export interface ModeContext {
  mode: AppMode;
  dir: string;
  mediaDir: string;
  batches: JsonCollection<Batch>;
  tasks: JsonCollection<Task>;
  media: JsonCollection<MediaRecord>;
  idem: JsonCollection<IdemRecord>;
  connections: JsonDoc<ConnectionsDoc>;
  demo: JsonDoc<DemoDoc>;
}


export interface AppContext {
  config: Config;
  clock: Clock;
  prober: Prober;
  fetch: FetchLike;
  vault: TokenVault;
  linkSecret: Buffer;
  bootId: string;
  settings: JsonDoc<{ mode: AppMode }>;
  modes: Record<AppMode, ModeContext>;
  /** state OAuth já usados (uso único entre instâncias): nonce -> expiração (ms). */
  oauthUsed: JsonDoc<{ used: Record<string, number> }>;
  /** Recarrega o estado persistido que outras instâncias possam ter alterado. */
  refresh(modes?: AppMode[]): Promise<void>;
  batchLocks: KeyedMutex;
  taskLocks: KeyedMutex;
  current(): ModeContext;
}

type Factory = {
  col<T extends { id: string }>(mode: string, name: string): CollectionBackend<T>;
  doc<T extends object>(mode: string, name: string): CollectionBackend<T & { id: string }>;
};

// Leave time to persist failure/reconciliation state before the 300s hard limit.
function deadlineFetch(fetchImpl: FetchLike, budget: number): FetchLike {
  const deadline = Date.now() + Math.min(budget, 240_000);
  return (url, init) => {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    return fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
  };
}

function factory(config: Config, fetchImpl: FetchLike): Factory {
  if (config.storage === 'redis') {
    const redis = new RedisRest(config.redis.url, config.redis.token, fetchImpl);
    const key = (mode: string, name: string) => `${config.redis.prefix}:${mode}:${name}`;
    return {
      col: (mode, name) => new RedisBackend(redis, key(mode, name)),
      doc: (mode, name) => new RedisBackend(redis, key(mode, name)),
    };
  }
  const file = (mode: string, name: string) => (mode ? path.join(config.dataDir, mode, `${name}.json`) : path.join(config.dataDir, `${name}.json`));
  return {
    col: (mode, name) => new FileBackend(file(mode, name)),
    doc: (mode, name) => new FileDocBackend(file(mode, name)) as any,
  };
}

async function createMode(mode: AppMode, root: string, f: Factory): Promise<ModeContext> {
  const dir = path.join(root, mode);
  const mediaDir = path.join(dir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  return {
    mode,
    dir,
    mediaDir,
    batches: await new JsonCollection<Batch>(f.col(mode, 'batches')).load(),
    tasks: await new JsonCollection<Task>(f.col(mode, 'tasks')).load(),
    media: await new JsonCollection<MediaRecord>(f.col(mode, 'media')).load(),
    idem: await new JsonCollection<IdemRecord>(f.col(mode, 'idempotency')).load(),
    connections: await new JsonDoc<ConnectionsDoc>(f.doc(mode, 'connections'), {}).load(),
    demo: await new JsonDoc<DemoDoc>(f.doc(mode, 'demo-remote'), { faults: {}, remote: {} }).load(),
  };
}

export async function createContext(opts: {
  config: Config;
  clock?: Clock;
  prober?: Prober;
  fetchImpl?: FetchLike;
}): Promise<AppContext> {
  const { config } = opts;
  await fs.mkdir(config.dataDir, { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const f = factory(config, fetchImpl);
  const settings = await new JsonDoc<{ mode: AppMode }>(f.doc('', 'settings'), { mode: 'real' }).load();
  const oauthUsed = await new JsonDoc<{ used: Record<string, number> }>(f.doc('', 'oauth-used'), { used: {} }).load();
  const modes = {
    demo: await createMode('demo', config.dataDir, f),
    real: await createMode('real', config.dataDir, f),
  };
  const ctx: AppContext = {
    config,
    clock: opts.clock ?? systemClock,
    prober: opts.prober ?? createFfprobe(config.ffprobePath),
    fetch: config.runtime === 'vercel' ? deadlineFetch(fetchImpl, config.tickBudgetMs) : fetchImpl,
    vault: new TokenVault(config.tokenKey),
    // Derivada da chave mestra: links assinados continuam válidos após reiniciar o backend.
    linkSecret: config.tokenKey ? deriveKey(config.tokenKey, 'links-de-midia') : crypto.randomBytes(32),
    bootId: crypto.randomBytes(8).toString('hex'),
    settings,
    modes,
    oauthUsed,
    refresh: async (list) => {
      await settings.refresh();
      const which = list ?? [settings.get().mode];
      await Promise.all(
        which.flatMap((m) => {
          const mc = modes[m];
          return [mc.batches.refresh(), mc.tasks.refresh(), mc.media.refresh(), mc.idem.refresh(), mc.connections.refresh(), mc.demo.refresh()];
        }),
      );
    },
    batchLocks: new KeyedMutex(),
    taskLocks: new KeyedMutex(),
    current: () => modes[settings.get().mode],
  };
  return ctx;
}
