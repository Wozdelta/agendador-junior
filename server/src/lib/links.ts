// URLs de midia autenticadas; upload direto e privado no Supabase Storage.
import type { AppContext, ModeContext } from '../context.js';

export interface Links {
  media(id: string): string;
  upload(batchId: string, itemId: string, kind: 'video' | 'cover'): string;
}

export function linksFor(ctx: AppContext, mc: ModeContext): Links {
  return {
    media: (id) => mc.media.get(id)?.blobUrl ?? `/api/media/${id}`,
    upload: (b, i, kind) => ctx.config.mediaStorage === 'supabase' ? `storage:${mc.mode}:${b}:${i}:${kind}` : `/api/batches/${b}/items/${i}/${kind}`,
  };
}
