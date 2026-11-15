import { Router } from 'express';
import { DateTime } from 'luxon';
import type { AppContext } from '../context.js';
import { JsonCollection } from '../lib/store.js';
import { SupabaseBackend } from '../lib/supabase.js';
import { AppError } from '../lib/errors.js';
import { ah } from './middleware.js';
import { PLATFORMS, type Platform } from '../shared/types.js';
import { publicationTexts, mergePublicationTexts, type PublicationTexts } from '../shared/publication.js';
import { validatePlatform } from '../shared/limits.js';
interface Entry {
  id: string;
  batchId?: string;
  date: string;
  originalName: string;
  title: string;
  description: string;
  platforms: Record<string, boolean>;
  texts?: PublicationTexts;
  textVersion?: number;
}
function validate(value: any): Entry {
  for (const [field, max] of [
    ['id', 160],
    ['originalName', 1024],
    ['title', 1024],
    ['description', 10000],
  ] as const)
    if (typeof value?.[field] !== 'string' || value[field].length > max)
      throw new AppError(400, `Campo ${field} inválido.`);
  if (
    !value.id ||
    (value.batchId !== undefined &&
      (typeof value.batchId !== 'string' || value.batchId.length > 160))
  )
    throw new AppError(400, 'Identificador inválido.');
  if (
    typeof value.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    !DateTime.fromISO(value.date, { zone: 'America/Sao_Paulo' }).isValid
  )
    throw new AppError(400, 'Data inválida.');
  if (
    !value.platforms ||
    Array.isArray(value.platforms) ||
    !Object.keys(value.platforms).length ||
    Object.entries(value.platforms).some(
      ([p, v]) => !PLATFORMS.includes(p as any) || typeof v !== 'boolean',
    )
  )
    throw new AppError(400, 'Selecione plataformas válidas.');
  if (value.texts !== undefined && (!value.texts || typeof value.texts !== 'object' || Array.isArray(value.texts) || Object.entries(value.texts).some(([p, t]: [string, any]) => !PLATFORMS.includes(p as Platform) || !t || typeof t !== 'object' || ['title', 'description'].some(f => t[f] !== undefined && typeof t[f] !== 'string'))))
    throw new AppError(400, 'Textos por plataforma inválidos.');
  const texts = publicationTexts(value);
  for (const p of Object.keys(value.platforms) as Platform[]) {
    const errors = validatePlatform(p, { ...texts[p], madeForKids: false }, undefined).filter(i => i.level === 'error');
    if (errors.length) throw new AppError(400, errors.map(i => i.message).join(' '));
  }
  return {
    id: value.id,
    batchId: value.batchId,
    date: value.date,
    originalName: value.originalName,
    title: value.title,
    description: value.description,
    platforms: value.platforms,
    texts,
    textVersion: 2,
  };
}
export function manualRoutes(ctx: AppContext) {
  const r = Router();
  const collection = () =>
    new JsonCollection<Entry>(
      new SupabaseBackend(ctx.config, () => ctx.ownerId, 'real', 'manual', ctx.fetch),
    );
  r.get(
    '/manual',
    ah(async (_req, res) => {
      const c = await collection().load();
      res.json({ rows: c.all().map(row => ({ ...row, texts: publicationTexts(row), textVersion: 2 })) });
    }),
  );
  r.post(
    '/manual',
    ah(async (req, res) => {
      const ops = req.body?.ops;
      if (!Array.isArray(ops) || ops.length > 200)
        throw new AppError(400, 'Envie no máximo 200 alterações por vez.');
      const c = await collection().load();
      await c.mutate((rows) => {
        for (const op of ops) {
          if (op.type === 'insert') {
            const value = validate(op.value);
            if (!rows.some((x) => x.id === value.id)) rows.push(value);
          } else if (op.type === 'remove') {
            const index = rows.findIndex((x) => x.id === op.id);
            if (index >= 0) rows.splice(index, 1);
          } else if (op.type === 'patch') {
            const index = rows.findIndex((x) => x.id === op.id);
            if (index < 0)
              throw new AppError(409, 'Registro alterado em outra sessão. Recarregue a agenda.');
            const patch = op.patch ?? {};
            if (Object.keys(patch).some((k) => !['title', 'description', 'platforms', 'texts', 'textVersion'].includes(k)))
              throw new AppError(400, 'Alteração inválida.');
            rows[index] = validate({
              ...rows[index],
              ...patch,
              texts: mergePublicationTexts(publicationTexts(rows[index]), patch.texts ?? {}),
              textVersion: 2,
              platforms: { ...rows[index].platforms, ...patch.platforms },
            });
          } else throw new AppError(400, 'Operação inválida.');
        }
      });
      res.json({ rows: c.all() });
    }),
  );
  return r;
}
