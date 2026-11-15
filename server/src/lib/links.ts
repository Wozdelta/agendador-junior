// URLs de mídia e de envio entregues à interface.
// - Vercel: vídeos e capas ficam no Vercel Blob; a prévia usa a própria URL do Blob
//   e o envio é feito pelo navegador direto para o Blob (client upload).
// - Local: rotas /api do Node.
import type { AppContext, ModeContext } from '../context.js';

export interface Links {
  media(id: string): string;
  upload(batchId: string, itemId: string, kind: 'video' | 'cover'): string;
}

export function linksFor(ctx: AppContext, mc: ModeContext): Links {
  return {
    media: (id) => mc.media.get(id)?.blobUrl ?? `/api/media/${id}`,
    upload: (b, i, kind) => ctx.config.mediaStorage === 'blob' ? `blob:${mc.mode}:${b}:${i}:${kind}` : `/api/batches/${b}/items/${i}/${kind}`,
  };
}
