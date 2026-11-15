// Cliente da API local. Nenhuma credencial passa pelo navegador: o backend guarda
// tokens e segredos; aqui só trafegam dados de lote, agenda e estado das conexões.
import type {
  BatchDTO,
  BatchSummary,
  ConnectionDTO,
  Platform,
  PlatformTexts,
  SettingsDTO,
  TaskDTO,
} from '../../../server/src/shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
    public code?: string,
  ) {
    super(message);
  }
}

export function idemKey(): string {
  return crypto.randomUUID();
}

async function call<T>(method: string, url: string, body?: unknown, opts: { idem?: string; keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'same-origin', method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive: opts.keepalive });
  } catch {
    throw new ApiError(0, 'Sem conexão com o backend. Verifique se o servidor está rodando (npm run dev).');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Erro ${res.status}`, data?.details, data?.code);
  return data as T;
}

export interface DraftAgendaRow {
  batchId: string;
  itemId: string;
  originalName: string;
  plannedAt: string;
  plannedLocal: string;
  platforms: Platform[];
}

export const api = {
  settings: () => call<SettingsDTO>('GET', '/api/settings'),
  setMode: (mode: 'demo' | 'real') => call<SettingsDTO>('POST', '/api/settings/mode', { mode, confirm: true }),
  setFault: (platform: Platform, kind: string | null, times = 1) => call('POST', '/api/demo/faults', { platform, kind, times }),

  drafts: () => call<BatchDTO[]>('GET', '/api/batches?status=draft'),
  batch: (id: string) => call<BatchDTO>('GET', `/api/batches/${id}`),
  createBatch: (startDate: string, idem: string) => call<BatchDTO>('POST', '/api/batches', { startDate }, { idem }),
  patchBatch: (id: string, body: { startDate?: string; platforms?: Partial<Record<Platform, boolean>> }) =>
    call<BatchDTO>('PATCH', `/api/batches/${id}`, body),
  deleteBatch: (id: string) => call('DELETE', `/api/batches/${id}`),
  reserveItems: (id: string, files: Array<{ name: string; size: number }>) =>
    call<{ batch: BatchDTO; itemIds: string[] }>('POST', `/api/batches/${id}/items`, { files }),
  patchItem: (
    id: string,
    itemId: string,
    body: { platforms?: Partial<Record<Platform, Partial<PlatformTexts>>>; coverFrameMs?: number },
    keepalive = false,
  ) => call<BatchDTO>('PATCH', `/api/batches/${id}/items/${itemId}`, body, { keepalive }),
  deleteItem: (id: string, itemId: string) => call<BatchDTO>('DELETE', `/api/batches/${id}/items/${itemId}`),
  reorder: (id: string, itemIds: string[]) => call<BatchDTO>('PUT', `/api/batches/${id}/order`, { itemIds }),
  deleteCover: (id: string, itemId: string) => call<BatchDTO>('DELETE', `/api/batches/${id}/items/${itemId}/cover`),
  summary: (id: string) => call<BatchSummary>('GET', `/api/batches/${id}/summary`),
  confirm: (id: string, idem: string) => call<{ batch: BatchDTO; tasks: TaskDTO[] }>('POST', `/api/batches/${id}/confirm`, undefined, { idem }),

  tasks: () => call<{ tasks: TaskDTO[]; drafts: DraftAgendaRow[] }>('GET', '/api/tasks'),
  taskAction: (id: string, action: 'cancel' | 'retry' | 'reschedule' | 'manual-complete' | 'resolve-review', body: unknown, idem: string) =>
    call<TaskDTO>('POST', `/api/tasks/${id}/${action}`, body, { idem }),
  editTask: (id: string, body: { title?: string; description?: string }, idem: string) => call<TaskDTO>('PATCH', `/api/tasks/${id}`, body, { idem }),

  connections: () => call<ConnectionDTO[]>('GET', '/api/connections'),
  selectPage: (pageId: string) => call<ConnectionDTO>('POST', '/api/connections/facebook/page', { pageId }),
  disconnect: (platform: Platform) => call('POST', `/api/connections/${platform}/disconnect`, {}),
  creatorInfo: () => call<{ privacy_level_options: string[]; creator_nickname?: string; max_video_post_duration_sec?: number; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean }>('GET', '/api/connections/tiktok/creator-info'),
};

/**
 * Envio de arquivo com progresso (XHR, pois fetch não informa progresso de upload).
 * A URL vem do backend: rota /api local ou link assinado direto no backend quando a
 * interface está hospedada (os vídeos não passam pela Vercel).
 */
export function uploadFile(url: string, file: File, onProgress: (pct: number) => void): Promise<BatchDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: any;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error ?? `Erro ${xhr.status} no envio`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Falha de rede durante o envio.'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

/** Link de download a partir da URL de mídia entregue pelo backend. */
export const downloadUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}download=1`;
