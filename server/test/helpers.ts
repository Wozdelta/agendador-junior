import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { log } from '../src/lib/log.js';
import { Worker } from '../src/queue/worker.js';
import type { FetchLike } from '../src/lib/http.js';

log.setSilent(true);

const FIX = path.join(os.tmpdir(), 'agendador-fixtures-v1');

/** Gera vídeos e imagens reais com ffmpeg (uma vez por máquina). */
export function fixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const mk = (name: string, args: string[]) => {
    const out = path.join(FIX, name);
    if (!fs.existsSync(out)) execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, out]);
    return out;
  };
  return {
    vertical: mk('vertical.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
    horizontal: mk('horizontal.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']),
    cover: mk('cover.jpg', ['-f', 'lavfi', '-i', 'color=c=red:s=360x640', '-frames:v', '1']),
    notVideo: (() => {
      const p = path.join(FIX, 'texto.mp4');
      fs.writeFileSync(p, 'isto não é um vídeo, só texto com extensão falsa');
      return p;
    })(),
  };
}

export class TestClock {
  offsetMs = 0;
  now = () => new Date(Date.now() + this.offsetMs);
  /** Avança o relógio para um instante (ISO) ou por milissegundos. */
  set(iso: string) {
    this.offsetMs = new Date(iso).getTime() - Date.now();
  }
  advance(ms: number) {
    this.offsetMs += ms;
  }
}

/** Data futura em DD/MM/AAAA (n dias a partir de hoje em São Paulo). */
export function futureBr(days: number): string {
  return DateTime.now().setZone('America/Sao_Paulo').plus({ days }).toFormat('dd/MM/yyyy');
}
export function pastBr(days: number): string {
  return DateTime.now().setZone('America/Sao_Paulo').minus({ days }).toFormat('dd/MM/yyyy');
}

export interface Env {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  api: ReturnType<typeof request>;
  worker: Worker;
  clock: TestClock;
  dir: string;
}

export async function makeEnv(opts: { dir?: string; mode?: 'demo' | 'real'; clock?: TestClock; fetchImpl?: FetchLike; config?: Partial<Config> } = {}): Promise<Env> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agendador-teste-'));
  const clock = opts.clock ?? new TestClock();
  const config = loadConfig({
    dataDir: dir,
    tokenKey: Buffer.alloc(32, 7).toString('base64'),
    workerTickMs: 1_000_000,
    ...opts.config,
  });
  const ctx = await createContext({ config, clock, fetchImpl: opts.fetchImpl });
  if (opts.mode !== 'real') await ctx.settings.mutate((s) => (s.mode = 'demo'));
  const worker = new Worker(ctx);
  await worker.recover();
  const app = createApp(ctx,(_req,_res,next)=>{ctx.ownerId='00000000-0000-4000-8000-000000000001';next();});
  return { ctx, app, api: request(app), worker, clock, dir };
}

let keyN = 0;
export const idemKey = () => `teste-${Date.now()}-${++keyN}-chave`;

/** Cria um rascunho com N vídeos enviados e textos preenchidos para todas as redes. */
export async function draftWithVideos(env: Env, startBr: string, n: number, file = fixtures().vertical) {
  const created = await env.api.post('/api/batches').send({ startDate: startBr }).expect(201);
  const id = created.body.id;
  const names = Array.from({ length: n }, (_, i) => ({ name: `video-${i + 1}.mp4`, size: fs.statSync(file).size }));
  const reserved = await env.api.post(`/api/batches/${id}/items`).send({ files: names }).expect(201);
  for (const itemId of reserved.body.itemIds) {
    await env.api.put(`/api/batches/${id}/items/${itemId}/video`).attach('file', file).expect(200);
  }
  for (const [i, itemId] of reserved.body.itemIds.entries()) {
    await env.api
      .patch(`/api/batches/${id}/items/${itemId}`)
      .send({
        platforms: {
          facebook: { title: `FB título ${i + 1}`, description: `FB descrição ${i + 1}` },
          youtube: { title: `YT título ${i + 1}`, description: `YT descrição ${i + 1}`, madeForKids: false },
          instagram: { description: `IG legenda ${i + 1} #teste` },
          tiktok: { description: `TT descrição ${i + 1}` },
        },
      })
      .expect(200);
  }
  return { id, itemIds: reserved.body.itemIds as string[] };
}
