// Cliente da API no mesmo domínio. Nenhuma credencial passa pelo navegador: a API guarda
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
import type { ManualEntry } from './manual-agenda';

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
    throw new ApiError(0, 'Serviço indisponível ou sem conexão. Tente de novo em instantes.');
  }
  let text: string;
  try { text = await res.text(); }
  catch { throw new ApiError(res.status, 'A conexão com o serviço foi interrompida. Tente de novo em instantes.', undefined, 'invalid_response'); }
  let data: any;
  try {
    if (!res.headers.get('content-type')?.includes('json')) throw new Error();
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, `Serviço indisponível: resposta inválida da API (HTTP ${res.status}). Tente de novo em instantes.`, undefined, 'invalid_response');
  }
  if(res.status===401&&!url.startsWith('/api/auth/')) window.dispatchEvent(new Event('agendador-session-expired'));
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
  importLegacy: (backup:unknown) => call<{ok:boolean;imported:Record<string,number>}>('POST','/api/migration/legacy',backup),
  session: () => call<{user:{id:string;email:string}|null}>('GET','/api/auth/session'),
  login: (email:string,password:string) => call<{user:{id:string;email:string}}>('POST','/api/auth/login',{email,password}),
  logout: () => call('POST','/api/auth/logout',{}),
  manual: () => call<{rows:ManualEntry[]}>('GET','/api/manual'),
  saveManual: (ops:unknown[]) => call<{rows:ManualEntry[]}>('POST','/api/manual',{ops}),
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

  tasks: () => call<{ tasks: TaskDTO[]; drafts: DraftAgendaRow[]; warning?: string }>('GET', '/api/tasks'),
  processNative: () => call<{ ok: boolean; message: string }>('POST', '/api/tasks/process-native', {}),
  taskAction: (id: string, action: 'cancel' | 'retry' | 'reschedule' | 'manual-complete' | 'resolve-review', body: unknown, idem: string) =>
    call<TaskDTO>('POST', `/api/tasks/${id}/${action}`, body, { idem }),
  editTask: (id: string, body: { title?: string; description?: string }, idem: string) => call<TaskDTO>('PATCH', `/api/tasks/${id}`, body, { idem }),

  connections: () => call<ConnectionDTO[]>('GET', '/api/connections'),
  startConnection: (platform: Platform) => call<{url:string}>('POST', `/api/connections/${platform}/start`, {returnTo:window.location.origin}),
  selectPage: (pageId: string) => call<ConnectionDTO>('POST', '/api/connections/facebook/page', { pageId }),
  disconnect: (platform: Platform) => call('POST', `/api/connections/${platform}/disconnect`, {}),
  creatorInfo: () => call<{ privacy_level_options: string[]; creator_nickname?: string; max_video_post_duration_sec?: number; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean }>('GET', '/api/connections/tiktok/creator-info'),
};

/**
 * Envio de arquivo com progresso (XHR, pois fetch não informa progresso de upload).
 * A URL vem da API: multipart local ou upload direto para o Supabase Storage.
 */
export function uploadFile(url: string, file: File, onProgress: (pct: number) => void): Promise<BatchDTO> {
  if (url.startsWith('storage:')) return uploadStorage(url, file, onProgress);
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
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else if (xhr.status >= 200 && xhr.status < 300) reject(new ApiError(xhr.status, 'Resposta inválida no envio. Tente de novo.'));
      else reject(new ApiError(xhr.status, data?.error ?? `Erro ${xhr.status} no envio`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Falha de rede durante o envio.'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

async function uploadStorage(url: string, file: File, onProgress: (pct: number) => void): Promise<BatchDTO> {
  const [, mode, batchId, itemId, kind] = url.split(':');
  if (kind === 'cover' && file.type === 'image/png') {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new ApiError(0, 'Não foi possível preparar a capa. Envie uma imagem JPEG.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!jpeg) throw new ApiError(0, 'Não foi possível converter a capa. Envie uma imagem JPEG.');
    file = new File([jpeg], 'capa.jpg', { type: 'image/jpeg' });
  }
  const { ticket, url: signedUrl } = await call<{ticket:string;url:string}>('POST','/api/storage/prepare',{batchId,itemId,kind});
  await new Promise<void>((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',signedUrl);xhr.setRequestHeader('Content-Type',file.type);
    xhr.upload.onprogress=e=>e.lengthComputable&&onProgress(Math.round(e.loaded/e.total*100));
    xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new ApiError(xhr.status,'Upload recusado. Confira o limite do Storage e tente de novo.'));
    xhr.onerror=()=>reject(new ApiError(0,'Falha de rede no upload. Tente de novo.'));xhr.send(file);
  });
  return call<BatchDTO>('POST','/api/storage/complete',{ticket});
}

/** Link de download a partir da URL de mídia entregue pelo backend. */
export const downloadUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}download=1`;
