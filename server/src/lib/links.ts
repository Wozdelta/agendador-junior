// URLs de mídia e de upload entregues à interface.
// - Acesso local (localhost): rotas /api normais.
// - Acesso remoto (interface na Vercel): links assinados e temporários direto no
//   backend (PUBLIC_BASE_URL), para vídeos não passarem pela Function de proxy
//   (limite de 4,5 MB no corpo e 120 s/300 s de duração).
import type { AppContext, ModeContext } from '../context.js';
import { signMediaToken, verifyMediaToken } from './crypto.js';

export type Access = 'local' | 'remote';

export interface Links {
  media(id: string): string;
  upload(batchId: string, itemId: string, kind: 'video' | 'cover'): string;
}

const MEDIA_TTL_MS = 6 * 3600_000;
const UPLOAD_TTL_MS = 3 * 3600_000;

export function linksFor(ctx: AppContext, mc: ModeContext, access: Access): Links {
  const base = ctx.config.publicBaseUrl;
  if (access === 'local' || !base) {
    return {
      media: (id) => `/api/media/${id}`,
      upload: (b, i, kind) => `/api/batches/${b}/items/${i}/${kind}`,
    };
  }
  const now = ctx.clock.now().getTime();
  return {
    media: (id) => `${base}/direct/media/${signMediaToken(ctx.linkSecret, `${mc.mode}|m|${id}`, now + MEDIA_TTL_MS)}`,
    upload: (b, i, kind) => `${base}/direct/upload/${signMediaToken(ctx.linkSecret, `${mc.mode}|u|${b}|${i}|${kind}`, now + UPLOAD_TTL_MS)}`,
  };
}

export type DirectGrant =
  | { type: 'media'; mode: 'demo' | 'real'; mediaId: string }
  | { type: 'upload'; mode: 'demo' | 'real'; batchId: string; itemId: string; kind: 'video' | 'cover' };

export function readDirectToken(ctx: AppContext, token: string): DirectGrant | null {
  const subject = verifyMediaToken(ctx.linkSecret, token, ctx.clock.now().getTime());
  if (!subject) return null;
  const parts = subject.split('|');
  const mode = parts[0];
  if (mode !== 'demo' && mode !== 'real') return null;
  if (parts[1] === 'm' && parts.length === 3) return { type: 'media', mode, mediaId: parts[2] };
  if (parts[1] === 'u' && parts.length === 5 && (parts[4] === 'video' || parts[4] === 'cover')) {
    return { type: 'upload', mode, batchId: parts[2], itemId: parts[3], kind: parts[4] };
  }
  return null;
}
