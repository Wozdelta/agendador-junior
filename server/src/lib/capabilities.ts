import type { AppContext } from '../context.js';
import { AppError } from './errors.js';

export const hasPersistence = (ctx: AppContext) => ctx.config.runtime !== 'vercel' || ['redis', 'supabase'].includes(ctx.config.storage);
export const hasMediaStorage = (ctx: AppContext) => ctx.config.runtime !== 'vercel' || ctx.config.mediaStorage === 'supabase';
export function requirePersistence(ctx: AppContext): void {
  if (!hasPersistence(ctx)) throw new AppError(409, 'Esta ação precisa do Supabase configurado na Vercel para salvar os dados. Confira as variáveis do servidor e tente novamente.', undefined, 'persistence_required');
}
export function requireOAuth(ctx: AppContext): void {
  requirePersistence(ctx);
  if (!ctx.vault.available) throw new AppError(409, 'Não foi possível configurar a criptografia dos tokens. Confira TOKEN_ENCRYPTION_KEY (32 bytes em base64); quando ela não é definida, o servidor usa SUPABASE_SECRET_KEY para derivar a chave.', undefined, 'encryption_required');
}
export function requireMediaStorage(ctx: AppContext): void {
  requirePersistence(ctx);
  if (!hasMediaStorage(ctx)) throw new AppError(409, 'Guardar vídeos na Vercel exige armazenamento de mídia. Use a agenda manual e envie o arquivo diretamente na plataforma.', undefined, 'media_storage_required');
}
