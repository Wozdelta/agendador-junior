import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import type { Request } from 'express';
import { AppError } from './errors.js';
import { sniff } from './media.js';

export interface ReceivedFile {
  tmpPath: string;
  size: number;
  originalName: string;
  kind: 'video' | 'image';
  mime: string;
  ext: string;
}

/**
 * Recebe UM arquivo multipart por streaming direto para o disco, sem bufferizar
 * em memória. Valida tamanho durante o envio e o tipo real pelos primeiros bytes.
 */
export function receiveFile(req: Request, opts: { dir: string; maxBytes: number; kind: 'video' | 'image' }): Promise<ReceivedFile> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: opts.maxBytes, fields: 5 } });
    } catch {
      reject(new AppError(400, 'Envie o arquivo como multipart/form-data.'));
      return;
    }
    let got = false;
    let failed: Error | null = null;
    let done: Promise<ReceivedFile> | null = null;

    bb.on('file', (_field, stream, info) => {
      if (got) {
        stream.resume();
        return;
      }
      got = true;
      const tmpPath = path.join(opts.dir, `.upload-${crypto.randomBytes(12).toString('hex')}.part`);
      let size = 0;
      let head = Buffer.alloc(0);
      let detected: ReturnType<typeof sniff> = null;
      let truncated = false;
      stream.on('limit', () => {
        truncated = true;
      });
      const inspector = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (head.length < 64) {
            head = Buffer.concat([head, chunk]).subarray(0, 64);
            if (head.length >= 12 && !detected) {
              detected = sniff(head);
              if (!detected || detected.kind !== opts.kind) {
                cb(new AppError(415, opts.kind === 'video' ? 'Formato não suportado. Envie vídeo MP4 ou MOV.' : 'Formato não suportado. Envie imagem JPEG ou PNG.'));
                return;
              }
            }
          }
          cb(null, chunk);
        },
      });
      done = pipeline(stream, inspector, fs.createWriteStream(tmpPath, { flags: 'wx' }))
        .then(async () => {
          if (truncated) {
            await fs.promises.rm(tmpPath, { force: true });
            throw new AppError(413, `Arquivo grande demais (máximo ${Math.round(opts.maxBytes / 1024 / 1024)} MB).`);
          }
          if (!detected) detected = sniff(head);
          if (!detected || detected.kind !== opts.kind) {
            await fs.promises.rm(tmpPath, { force: true });
            throw new AppError(415, 'Arquivo vazio ou formato não suportado.');
          }
          const d = detected as NonNullable<ReturnType<typeof sniff>>;
          return { tmpPath, size, originalName: info.filename || 'arquivo', kind: d.kind, mime: d.mime, ext: d.ext };
        })
        .catch(async (err) => {
          await fs.promises.rm(tmpPath, { force: true });
          throw err;
        });
      done.catch((e) => {
        failed = e;
      });
    });
    bb.on('error', (err) => reject(new AppError(400, `Falha ao receber o arquivo: ${(err as Error).message}`)));
    bb.on('close', async () => {
      if (!got || !done) return reject(new AppError(400, 'Nenhum arquivo foi enviado.'));
      try {
        resolve(await done);
      } catch (err) {
        reject(failed ?? err);
      }
    });
    req.on('aborted', () => reject(new AppError(400, 'Envio interrompido.')));
    req.pipe(bb);
  });
}
