import { supabase, storageUrl, MEDIA_BUCKET } from './supabase.js';
// Leitura e exclusão de vídeos/capas, no Supabase Storage privado ou em backups locais.
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext, ModeContext } from '../context.js';
import type { MediaRecord } from '../domain/model.js';
import { AppError, PermanentError } from './errors.js';
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
  if (!res.ok) throw new Error(`Não foi possível ler o arquivo no Storage (HTTP ${res.status}).`);
  return res;
}

/** Corpo para enviar às plataformas (stream), opcionalmente só um intervalo de bytes. */
export async function openMedia(ctx: AppContext, mc: ModeContext, m: MediaRecord, opts: { start?: number; end?: number } = {}): Promise<any> {
  if (m.storagePath) m = { ...m, blobUrl: await storageUrl(ctx.config,m.storagePath,ctx.fetch) };
  if (m.blobUrl) {
    if (opts.start === undefined && opts.end === undefined) return (await fetchRange(ctx, m.blobUrl)).body;
    return (await fetchRange(ctx, m.blobUrl, opts.start ?? 0, opts.end)).body;
  }
  if (ctx.config.runtime === 'vercel') throw new PermanentError('Este arquivo só existia no disco local e não está disponível na Vercel. Publique manualmente ou envie novamente para armazenamento persistente.');
  return fs.createReadStream(path.join(mc.mediaDir, m.internalName), opts);
}

export async function readMedia(ctx: AppContext, mc: ModeContext, m: MediaRecord): Promise<Buffer> {
  if (m.storagePath) m = { ...m, blobUrl: await storageUrl(ctx.config,m.storagePath,ctx.fetch) };
  if (m.blobUrl) return Buffer.from(await (await fetchRange(ctx, m.blobUrl)).arrayBuffer());
  if (ctx.config.runtime === 'vercel') throw new PermanentError('A mídia local não está disponível na Vercel. Use o arquivo original para a publicação manual.');
  return fs.promises.readFile(path.join(mc.mediaDir, m.internalName));
}

/** Leitor por intervalo de um arquivo remoto (para validar sem baixar tudo). */
export function remoteReader(ctx: AppContext, url: string): RangeReader {
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

export async function remoteSize(ctx: AppContext, url: string): Promise<number> {
  const res = await ctx.fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new AppError(422, `Arquivo não encontrado no Storage (HTTP ${res.status}).`);
  return Number(res.headers.get('content-length') ?? 0);
}

export async function deleteMediaObject(ctx: AppContext, mc: ModeContext, m: MediaRecord): Promise<void> {
  if(m.storagePath) {
    const {error}=await supabase(ctx.config,true,ctx.fetch).storage.from(MEDIA_BUCKET).remove([m.storagePath]);
    if(error) throw new AppError(503,'Não foi possível remover o arquivo. Tente de novo.');
    return;
  }
  if (m.blobUrl) {
    // Objetos legados permanecem no provedor antigo; nenhum token Blob e exigido.
    // Sua remocao remota deve ser feita no painel do provedor.
    return;
  }
  await fs.promises.rm(path.join(mc.mediaDir, m.internalName), { force: true });
}
