import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import type { AppMode } from './shared/types.js';
import { JsonCollection, JsonDoc } from './lib/store.js';
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

export interface OAuthPending {
  platform: string;
  verifier?: string;
  createdAt: number;
  returnTo: string;
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
  oauthStates: Map<string, OAuthPending>;
  batchLocks: KeyedMutex;
  taskLocks: KeyedMutex;
  current(): ModeContext;
}

async function createMode(mode: AppMode, root: string): Promise<ModeContext> {
  const dir = path.join(root, mode);
  const mediaDir = path.join(dir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  return {
    mode,
    dir,
    mediaDir,
    batches: await new JsonCollection<Batch>(path.join(dir, 'batches.json')).load(),
    tasks: await new JsonCollection<Task>(path.join(dir, 'tasks.json')).load(),
    media: await new JsonCollection<MediaRecord>(path.join(dir, 'media.json')).load(),
    idem: await new JsonCollection<IdemRecord>(path.join(dir, 'idempotency.json')).load(),
    connections: await new JsonDoc<ConnectionsDoc>(path.join(dir, 'connections.json'), {}).load(),
    demo: await new JsonDoc<DemoDoc>(path.join(dir, 'demo-remote.json'), { faults: {}, remote: {} }).load(),
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
  const settings = await new JsonDoc<{ mode: AppMode }>(path.join(config.dataDir, 'settings.json'), {
    mode: 'real',
  }).load();
  const modes = {
    demo: await createMode('demo', config.dataDir),
    real: await createMode('real', config.dataDir),
  };
  const ctx: AppContext = {
    config,
    clock: opts.clock ?? systemClock,
    prober: opts.prober ?? createFfprobe(config.ffprobePath),
    fetch: opts.fetchImpl ?? fetch,
    vault: new TokenVault(config.tokenKey),
    // Derivada da chave mestra: links assinados continuam válidos após reiniciar o backend.
    linkSecret: config.tokenKey ? deriveKey(config.tokenKey, 'links-de-midia') : crypto.randomBytes(32),
    bootId: crypto.randomBytes(8).toString('hex'),
    settings,
    modes,
    oauthStates: new Map(),
    batchLocks: new KeyedMutex(),
    taskLocks: new KeyedMutex(),
    current: () => modes[settings.get().mode],
  };
  return ctx;
}
