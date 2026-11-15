import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { SupabaseBackend } from '../lib/supabase.js';
import { JsonCollection } from '../lib/store.js';
import { AppError } from '../lib/errors.js';
import { requireOAuth } from '../lib/capabilities.js';
import { isBlobUrl } from '../lib/mediaio.js';
import { ah } from './middleware.js';
// Importação explícita de backups confiáveis. Nunca aceita nome de tabela do cliente.
export function migrationRoutes(ctx: AppContext) {
  const r = Router();
  r.post(
    '/migration/legacy',
    ah(async (req, res) => {
      const { mode, collections } = req.body ?? {};
      if (
        !['real', 'demo'].includes(mode) ||
        !collections ||
        typeof collections !== 'object' ||
        Array.isArray(collections)
      )
        throw new AppError(400, 'Backup inválido. Use mode e collections.');
      const names = ['batches', 'tasks', 'media', 'connections'];
      if (Object.keys(collections).some((k) => !names.includes(k)))
        throw new AppError(400, 'Coleção de backup não permitida.');
      const prepared: Array<[string, Array<{ id: string; [key: string]: any }>]> = [];
      for (const [name, rows] of Object.entries(collections)) {
        if (!Array.isArray(rows) || rows.length > 200)
          throw new AppError(400, 'Importe até 200 registros por coleção e arquivo.');
        for (const row of rows) {
          if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 160)
            throw new AppError(400, 'Registro sem ID válido.');
          if (
            name === 'batches' &&
            (!Array.isArray(row.items) ||
              !['draft', 'confirmed'].includes(row.status) ||
              row.mode !== mode ||
              row.timezone !== 'America/Sao_Paulo' ||
              row.publishTime !== '12:00')
          )
            throw new AppError(400, 'Lote incompatível com o fluxo atual.');
          if (
            name === 'tasks' &&
            (!row.platform ||
              row.mode !== mode ||
              !Array.isArray(row.history) ||
              !row.remote ||
              !row.options ||
              !row.cover)
          )
            throw new AppError(400, 'Tarefa incompleta. Preserve o backup original.');
          if (
            name === 'media' &&
            (!row.internalName ||
              path.basename(row.internalName) !== row.internalName ||
              (row.blobUrl && !isBlobUrl(row.blobUrl)) ||
              (row.storagePath && !row.storagePath.startsWith(`${ctx.ownerId}/`)))
          )
            throw new AppError(400, 'Metadados de mídia inválidos para esta conta.');
          if (name === 'connections') {
            if (
              row.id !== 'doc' ||
              Object.keys(row).some((k) => !['id', 'youtube', 'facebook', 'tiktok'].includes(k))
            )
              throw new AppError(400, 'Documento de conexões inválido.');
            requireOAuth(ctx);
            try {
              for (const platform of ['youtube', 'facebook', 'tiktok']) {
                const connection = row[platform];
                if (!connection) continue;
                if (connection.tokensEnc) ctx.vault.decrypt(connection.tokensEnc, platform);
                for (const page of connection.pages ?? [])
                  ctx.vault.decrypt(page.tokenEnc, `facebook-page:${page.id}`);
              }
            } catch {
              throw new AppError(
                400,
                'Os tokens do backup não podem ser abertos com TOKEN_ENCRYPTION_KEY. Preserve a chave anterior ou reconecte.',
              );
            }
          }
          const check = (v: any): void => {
            if (v && typeof v === 'object')
              for (const [key, value] of Object.entries(v)) {
                if (
                  /^(access_token|refresh_token|client_secret|accessToken|refreshToken)$/i.test(key)
                )
                  throw new AppError(400, 'O backup contém tokens sem criptografia.');
                check(value);
              }
          };
          check(row);
        }
        prepared.push([name, rows]);
      }
      const counts: Record<string, number> = {};
      for (const [name, rows] of prepared) {
        const collection = await new JsonCollection<any>(
          new SupabaseBackend(ctx.config, () => ctx.ownerId, mode, name, ctx.fetch),
        ).load();
        counts[name] = await collection.mutate((current) => {
          let added = 0;
          for (const row of rows)
            if (!current.some((x: any) => x.id === row.id)) {
              current.push(row);
              added++;
            }
          return added;
        });
      }
      res.json({ ok: true, imported: counts });
    }),
  );
  return r;
}
