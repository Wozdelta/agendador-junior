import type { AppContext } from '../context.js';
import { AppError } from './errors.js';

export const hasPersistence = (ctx: AppContext) => ctx.config.runtime !== 'vercel' || ['redis', 'supabase'].includes(ctx.config.storage);
export const hasMediaStorage = (ctx: AppContext) => ctx.config.runtime !== 'vercel' || ctx.config.mediaStorage === 'supabase';
export function requirePersistence(ctx: AppContext): void {
  if (!hasPersistence(ctx)) throw new AppError(409, 'Esta ação guarda dados no servidor e precisa de armazenamento persistente. A agenda manual continua disponível neste navegador.', undefined, 'persistence_required');
}
export function requireOAuth(ctx: AppContext): void {
  requirePersistence(ctx);
  if (!ctx.vault.available) throw new AppError(409, 'Para guardar tokens OAuth criptografados, configure TOKEN_ENCRYPTION_KEY com 32 bytes em base64. A publicação manual continua disponível.', undefined, 'encryption_required');
}
export function requireMediaStorage(ctx: AppContext): void {
  requirePersistence(ctx);
  if (!hasMediaStorage(ctx)) throw new AppError(409, 'Guardar vídeos na Vercel exige armazenamento de mídia. Use a agenda manual e envie o arquivo diretamente na plataforma.', undefined, 'media_storage_required');
}
