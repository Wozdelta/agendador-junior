// Envio direto do navegador para as redes. O arquivo sai do seu computador
// direto para o YouTube/Facebook; o servidor do app não guarda o vídeo.
import type { Platform, PostRecord } from '../../../server/src/shared/types';

export interface DirectSession {
  graphVersion: string;
  youtube?: { accessToken: string };
  facebook?: { pageId: string; pageName: string; pageToken: string };
  instagram?: { igId: string; username: string };
  errors: Partial<Record<Platform, string>>;
}

/** Bytes já enviados deste arquivo. */
type Progress = (sentBytes: number) => void;
export type Step = (msg: string) => void;

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Erro ${res.status}`);
  return data as T;
}

let saveQueue: Promise<unknown> = Promise.resolve();
export const directApi = {
  session: () => json<DirectSession>('POST', '/api/direct/session'),
  posts: () => json<PostRecord[]>('GET', '/api/direct/posts'),
  // Um de cada vez: o servidor regrava a lista inteira, e salvamentos simultâneos apagavam as outras redes.
  savePost: (p: Partial<PostRecord> & Pick<PostRecord, 'platform' | 'status'>) => {
    const run = saveQueue.then(() => json<PostRecord>('POST', '/api/direct/posts', p));
    saveQueue = run.catch(() => undefined);
    return run;
  },
  deletePost: (id: string, remote = false) => json<{ ok: true; warning?: string }>('DELETE', `/api/direct/posts/${encodeURIComponent(id)}${remote ? '?remote=1' : ''}`),
  igStart: (facebookVideoId: string, caption: string) =>
    json<{ state: 'waiting' | 'processing'; containerId?: string; fbStatus?: string }>('POST', '/api/direct/instagram/start', { facebookVideoId, caption }),
  igCreate: (caption: string, path?: string) => json<{ containerId: string }>('POST', '/api/direct/instagram/create', { caption, path }),
  igStage: (parts: number) => json<{ parts: Array<{ path: string; uploadUrl: string }> }>('POST', '/api/direct/instagram/stage', { parts }),
  igUnstage: (paths: string[]) => json<{ ok: true }>('POST', '/api/direct/instagram/unstage', { paths }),
  igCreateParts: (caption: string, paths: string[], sizes: number[]) => json<{ containerId: string }>('POST', '/api/direct/instagram/create', { caption, paths, sizes }),
  igCheck: (containerId: string, deleteFacebookVideoId?: string, path?: string) =>
    json<{ state: 'processing' | 'published' | 'failed'; id?: string; url?: string; error?: string }>('POST', '/api/direct/instagram/check', { containerId, deleteFacebookVideoId, path }),
};

/** PUT/POST com progresso (fetch não informa progresso de envio). */
function xhr(method: string, url: string, body: Blob | FormData, headers: Record<string, string>, onProgress?: Progress): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let j: any = null;
      try { j = JSON.parse(x.responseText); } catch {}
      resolve({ status: x.status, json: j });
    };
    x.onerror = () => reject(new Error('Falha de rede durante o envio. Confira a internet e tente de novo.'));
    x.send(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- YouTube ----------------
export async function uploadYouTube(
  s: DirectSession, video: File, cover: File | undefined,
  meta: { title: string; description: string; publishAt?: Date }, onProgress: Progress, step: Step = () => {},
): Promise<{ id: string; url: string; note?: string }> {
  const token = s.youtube?.accessToken;
  if (!token) throw new Error(s.errors.youtube ?? 'YouTube não conectado.');
  const future = meta.publishAt && meta.publishAt.getTime() > Date.now() + 60_000;
  step('Pedindo autorização de envio ao YouTube…');
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(video.size),
      'X-Upload-Content-Type': video.type || 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { title: meta.title.slice(0, 100), description: meta.description.replace(/[<>]/g, ''), categoryId: '22' },
      status: future
        ? { privacyStatus: 'private', publishAt: meta.publishAt!.toISOString(), selfDeclaredMadeForKids: false }
        : { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) {
    const e = await init.json().catch(() => ({}));
    throw new Error(`YouTube recusou o envio: ${e?.error?.message ?? init.status}`);
  }
  const location = init.headers.get('Location');
  if (!location) throw new Error('YouTube não devolveu o endereço de envio.');
  step('Enviando o vídeo ao YouTube…');
  const up = await xhr('PUT', location, video, { 'Content-Type': video.type || 'video/mp4' }, onProgress);
  if (up.status !== 200 && up.status !== 201) throw new Error(`YouTube: envio falhou (${up.json?.error?.message ?? up.status}).`);
  const id = up.json.id as string;
  let note: string | undefined;
  if (cover) {
    step('Aplicando a capa no YouTube…');
    const t = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: cover,
    });
    if (!t.ok) {
      const e = await t.json().catch(() => ({}));
      note = `Capa não aplicada: ${e?.error?.message ?? t.status} (o canal precisa estar verificado para usar capa personalizada).`;
    }
  }
  return { id, url: `https://youtube.com/shorts/${id}`, note };
}

// ---------------- Facebook ----------------
const CHUNK = 8 * 1024 * 1024;

export async function uploadFacebook(
  s: DirectSession, video: File, cover: File | undefined,
  meta: { title: string; description: string; publishAt?: Date; hidden?: boolean }, onProgress: Progress, step: Step = () => {},
): Promise<{ id: string; url?: string }> {
  const fb = s.facebook;
  if (!fb) throw new Error(s.errors.facebook ?? 'Facebook não conectado.');
  const endpoint = `https://graph-video.facebook.com/${s.graphVersion}/${fb.pageId}/videos`;
  const post = async (fields: Record<string, string | Blob>, progress?: Progress) => {
    const phase = String(fields.upload_phase);
    const f = new FormData();
    f.set('access_token', fb.pageToken);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    const r = await xhr('POST', endpoint, f, {}, progress);
    if (r.status !== 200 || r.json?.error) {
      const e = r.json?.error;
      throw new Error(`Facebook (etapa ${phase}): ${e?.error_user_msg ?? e?.message ?? `HTTP ${r.status}`}${e?.code ? ` [código ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}]` : ''}`);
    }
    return r.json;
  };
  step(`Abrindo envio na Página ${fb.pageName}…`);
  const start = await post({ upload_phase: 'start', file_size: String(video.size) });
  step('Enviando o vídeo ao Facebook…');
  const session = start.upload_session_id as string;
  const videoId = String(start.video_id);
  let from = Number(start.start_offset), to = Number(start.end_offset);
  while (from < to) {
    const base = from;
    const r = await post(
      { upload_phase: 'transfer', upload_session_id: session, start_offset: String(from), video_file_chunk: video.slice(from, Math.min(to, from + CHUNK)) },
      (sent) => onProgress(base + sent),
    );
    from = Number(r.start_offset); to = Number(r.end_offset);
  }
  const future = meta.publishAt && meta.publishAt.getTime() > Date.now() + 11 * 60_000;
  const finish: Record<string, string | Blob> = { upload_phase: 'finish', upload_session_id: session, title: meta.title, description: meta.description };
  if (meta.hidden) { finish.published = 'false'; }
  else if (future) { finish.published = 'false'; finish.scheduled_publish_time = String(Math.floor(meta.publishAt!.getTime() / 1000)); }
  if (cover) finish.thumb = cover;
  step(meta.hidden ? 'Finalizando (vídeo oculto, só para o Instagram)…' : future ? 'Finalizando e agendando no Facebook…' : 'Finalizando e publicando no Facebook…');
  await post(finish);
  onProgress(video.size);
  return { id: videoId, url: meta.hidden ? undefined : `https://www.facebook.com/${fb.pageId}/videos/${videoId}` };
}

// ---------------- Instagram (agora) ----------------
/** Instagram: o vídeo vai em pedaços de 4 MB pelo nosso servidor direto para o Instagram. */
/**
 * Instagram: o vídeo vai para uma pasta temporária (só durante o envio), o Instagram baixa
 * de lá e o arquivo é apagado em seguida — dando certo ou não.
 */
/**
 * Instagram: o vídeo vai em partes de até 45 MB para uma pasta temporária (o Storage aceita no
 * máximo 50 MB por arquivo). O Instagram baixa por um link nosso que junta as partes.
 * As partes são apagadas no fim, dando certo ou não.
 */
export async function uploadInstagram(video: File, caption: string, onProgress: Progress, onStatus: (msg: string) => void) {
  const PART = 45 * 1024 * 1024;
  const count = Math.max(1, Math.ceil(video.size / PART));
  onStatus('Preparando envio ao Instagram…');
  const { parts } = await directApi.igStage(count);
  const paths = parts.map((p) => p.path);
  const sizes = parts.map((_, i) => Math.min(PART, video.size - i * PART));
  try {
    for (let i = 0; i < parts.length; i++) {
      const start = i * PART;
      const blob = video.slice(start, Math.min(start + PART, video.size), 'video/mp4');
      const label = parts.length > 1 ? ` (parte ${i + 1} de ${parts.length})` : '';
      let up: { status: number; json: any } = { status: 0, json: null };
      for (let k = 1; k <= 3; k++) {
        onStatus(`Enviando vídeo ao Instagram${label}${k > 1 ? ` — tentativa ${k} de 3` : ''}…`);
        try {
          up = await xhr('PUT', parts[i].uploadUrl, blob, { 'Content-Type': 'video/mp4', 'x-upsert': 'true' }, (n) => onProgress(start + n));
          if (up.status < 300) break;
        } catch (e: any) {
          up = { status: 0, json: { message: e.message } };
        }
        if (k < 3) await sleep(4000);
      }
      if (up.status === 0 || up.status >= 300) throw new Error(`Envio ao Instagram falhou${label} (${up.status}): ${up.json?.message ?? up.json?.error ?? 'sem detalhe'}`);
    }
    onProgress(video.size);
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const tries = attempt > 1 ? ` (tentativa ${attempt} de 3)` : '';
      onStatus(`Criando o Reel${tries}…`);
      const { containerId } = await directApi.igCreateParts(caption, paths, sizes);
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('O Instagram demorou demais para processar o vídeo.');
        onStatus(`Instagram processando o Reel${tries}…`);
        await sleep(5000);
        const r = await directApi.igCheck(containerId);
        // (as partes ficam até o fim: o Instagram pode baixar de novo numa nova tentativa)
        if (r.state === 'published') return r;
        if (r.state === 'failed') { lastError = r.error || 'O Instagram não processou o vídeo.'; onStatus(`${lastError} — tentando de novo…`); await sleep(10000); break; }
      }
    }
    throw new Error(lastError);
  } finally {
    await directApi.igUnstage(paths).catch(() => undefined);
  }
}

export async function publishInstagram(facebookVideoId: string, caption: string, deleteCarrier: boolean, onStatus: (msg: string) => void) {
  const deadline = Date.now() + 20 * 60_000;
  let lastError = '';
  // O Instagram às vezes falha ao baixar o vídeo (ex.: 2207076); tenta de novo até 3 vezes.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let containerId: string | undefined;
    while (!containerId) {
      if (Date.now() > deadline) throw new Error(lastError || 'O Facebook demorou demais para processar o vídeo; o Instagram não foi publicado.');
      const r = await directApi.igStart(facebookVideoId, caption);
      if (r.containerId) containerId = r.containerId;
      else { onStatus(`Aguardando o Facebook terminar de processar o vídeo (${r.fbStatus ?? '…'})`); await sleep(8000); }
    }
    for (;;) {
      if (Date.now() > deadline) throw new Error(lastError || 'O Instagram demorou demais para processar o vídeo.');
      onStatus(attempt > 1 ? `Instagram processando o Reel (tentativa ${attempt} de 3)…` : 'Instagram processando o Reel…');
      await sleep(6000);
      const r = await directApi.igCheck(containerId, deleteCarrier ? facebookVideoId : undefined);
      if (r.state === 'published') return r;
      if (r.state === 'failed') { lastError = r.error || 'O Instagram não processou o vídeo.'; onStatus(`${lastError} — tentando de novo…`); await sleep(15000); break; }
    }
  }
  throw new Error(lastError);
}
