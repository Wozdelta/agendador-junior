// Leitura e exclusão de vídeos/capas, seja no disco local (DATA_DIR) ou no Vercel Blob.
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext, ModeContext } from '../context.js';
import type { MediaRecord } from '../domain/model.js';
import { AppError } from './errors.js';
import type { RangeReader } from './mp4.js';

/** Hosts aceitos para arquivos do Vercel Blob. */
export function isBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

async function fetchRange(ctx: AppContext, url: string, start?: number, end?: number): Promise<Response> {
  const headers: Record<string, string> = {};
  if (start !== undefined) headers.Range = `bytes=${start}-${end ?? ''}`;
  const res = await ctx.fetch(url, { headers });
  if (!res.ok) throw new Error(`Não foi possível ler o arquivo no Blob (HTTP ${res.status}).`);
  return res;
}

/** Corpo para enviar às plataformas (stream), opcionalmente só um intervalo de bytes. */
export async function openMedia(ctx: AppContext, mc: ModeContext, m: MediaRecord, opts: { start?: number; end?: number } = {}): Promise<any> {
  if (m.blobUrl) {
    if (opts.start === undefined && opts.end === undefined) return (await fetchRange(ctx, m.blobUrl)).body;
    return (await fetchRange(ctx, m.blobUrl, opts.start ?? 0, opts.end)).body;
  }
  return fs.createReadStream(path.join(mc.mediaDir, m.internalName), opts);
}

export async function readMedia(ctx: AppContext, mc: ModeContext, m: MediaRecord): Promise<Buffer> {
  if (m.blobUrl) return Buffer.from(await (await fetchRange(ctx, m.blobUrl)).arrayBuffer());
  return fs.promises.readFile(path.join(mc.mediaDir, m.internalName));
}

/** Leitor por intervalo de um arquivo no Blob (para validar sem baixar tudo). */
export function blobReader(ctx: AppContext, url: string): RangeReader {
  return async (offset, length) => {
    const res = await fetchRange(ctx, url, offset, offset + length - 1);
    if (res.status !== 206) {
      await res.body?.cancel();
      throw new AppError(422, 'O armazenamento não respondeu à leitura parcial do arquivo.');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== length) throw new AppError(422, 'Arquivo incompleto no armazenamento.');
    return buf;
  };
}

export async function blobSize(ctx: AppContext, url: string): Promise<number> {
  const res = await ctx.fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new AppError(422, `Arquivo não encontrado no Blob (HTTP ${res.status}).`);
  return Number(res.headers.get('content-length') ?? 0);
}

export async function deleteMediaObject(ctx: AppContext, mc: ModeContext, m: MediaRecord): Promise<void> {
  if (m.blobUrl) {
    const { del } = await import('@vercel/blob');
    await del(m.blobUrl, { token: ctx.config.blobToken }).catch(() => undefined);
    return;
  }
  await fs.promises.rm(path.join(mc.mediaDir, m.internalName), { force: true });
}
