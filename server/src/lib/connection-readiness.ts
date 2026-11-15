import type { AppContext } from '../context.js';
import type { Platform } from '../shared/types.js';
import { hasPersistence } from './capabilities.js';

/** Somente nomes de variáveis/ações chegam ao navegador, nunca seus valores. */
export function connectionBlockers(ctx: AppContext, platform: Platform, storageWarning?: string): string[] {
  const blockers: string[] = [];
  if (!hasPersistence(ctx)) blockers.push('Configure o Supabase na Vercel para salvar a autorização da conta.');
  if (!ctx.vault.available) blockers.push('A proteção dos tokens não está configurada. Confira SUPABASE_SECRET_KEY ou TOKEN_ENCRYPTION_KEY (32 bytes em base64) na Vercel.');
  const meta = platform === 'facebook' || platform === 'instagram';
  const variables = platform === 'youtube'
    ? [['GOOGLE_CLIENT_ID', ctx.config.google.clientId], ['GOOGLE_CLIENT_SECRET', ctx.config.google.clientSecret]]
    : meta ? [['META_APP_ID', ctx.config.meta.appId], ['META_APP_SECRET', ctx.config.meta.appSecret]]
    : [['TIKTOK_CLIENT_KEY', ctx.config.tiktok.clientKey], ['TIKTOK_CLIENT_SECRET', ctx.config.tiktok.clientSecret]];
  const missing = variables.filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length) blockers.push(`Defina ${missing.join(' e ')} nas variáveis da Vercel e faça um novo deploy.`);
  const redirect = platform === 'youtube' ? ctx.config.google.redirectUri : meta ? ctx.config.meta.redirectUri : ctx.config.tiktok.redirectUri;
  const variable = platform === 'youtube' ? 'GOOGLE_REDIRECT_URI' : meta ? 'META_REDIRECT_URI' : 'TIKTOK_REDIRECT_URI';
  const callbackPlatform = meta ? 'facebook' : platform;
  try {
    const url = new URL(redirect);
    if (url.pathname !== `/api/oauth/${callbackPlatform}/callback` || url.search || url.hash || url.username || url.password) throw new Error();
    if (ctx.config.runtime === 'vercel') {
      if (url.protocol !== 'https:' || url.origin !== new URL(ctx.config.appUrl).origin) throw new Error();
    } else if (!['http:', 'https:'].includes(url.protocol) || (platform === 'tiktok' && url.protocol !== 'https:')) throw new Error();
  } catch {
    blockers.push(`Confira ${variable}: use o domínio do app seguido de /api/oauth/${callbackPlatform}/callback e cadastre a mesma URL no provedor.`);
  }
  if (storageWarning) blockers.push(`${storageWarning} Confira também se supabase/setup.sql foi executado.`);
  return blockers;
}
