// Conectores REAIS contra um fetch simulado que imita as respostas documentadas.
// Não usa rede nem credenciais: verifica a sequência de chamadas, parâmetros,
// idempotência e reconciliação do código de produção.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { draftWithVideos, fixtures, futureBr, idemKey, makeEnv, type Env } from './helpers.js';
import { writeTokens } from '../src/platforms/tokens.js';

const fx = fixtures();

type Handler = { method: string; match: RegExp; reply: (url: URL, init: any, body: Buffer) => Response | Promise<Response> };
interface Call {
  method: string;
  url: string;
  body: Buffer;
  headers: Record<string, string>;
}

function fakeFetch() {
  const handlers: Handler[] = [];
  const calls: Call[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    let body = Buffer.alloc(0);
    if (init.body) {
      if (typeof init.body === 'string') body = Buffer.from(init.body);
      else if (init.body instanceof URLSearchParams) body = Buffer.from(init.body.toString());
      else if (Buffer.isBuffer(init.body)) body = init.body;
      else if (typeof init.body[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = [];
        for await (const c of init.body) chunks.push(Buffer.from(c));
        body = Buffer.concat(chunks);
      } else body = Buffer.from(await new Response(init.body).arrayBuffer());
    }
    calls.push({ method, url: url.toString(), body, headers: { ...(init.headers ?? {}) } });
    const h = [...handlers].reverse().find((x) => x.method === method && x.match.test(url.toString()));
    if (!h) throw new Error(`Chamada inesperada: ${method} ${url}`);
    return h.reply(url, init, body);
  }) as typeof fetch;
  const on = (method: string, match: RegExp, reply: Handler['reply']) => handlers.push({ method, match, reply });
  return { impl, calls, on };
}

const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

async function realEnv(f: ReturnType<typeof fakeFetch>, config: any = {}): Promise<Env> {
  const env = await makeEnv({ mode: 'real', fetchImpl: f.impl, config: { publicBaseUrl: 'https://tunel.exemplo.dev', ...config } });
  const mc = env.ctx.modes.real;
  const far = Date.now() + 365 * 86400_000;
  await writeTokens(env.ctx, mc, 'youtube', { access_token: 'ya29.teste', refresh_token: 'rt', expires_at: far });
  await mc.connections.mutate((d) => {
    d.youtube = { ...d.youtube, accountId: 'UC123', accountName: 'Meu Canal' };
    d.facebook = {
      tokensEnc: env.ctx.vault.encrypt({ access_token: 'EAAuser' }, 'facebook'),
      accountId: 'u1',
      accountName: 'Eu',
      pages: [{ id: 'PAGE1', name: 'Minha Página', tokenEnc: env.ctx.vault.encrypt('EAApage', 'facebook-page:PAGE1'), instagram: { id: 'IG1', username: 'minhaconta' } }],
      selectedPageId: 'PAGE1',
    };
  });
  return env;
}

async function confirmOnly(env: Env, platforms: string[], days = 5, withCover = false) {
  const { id, itemIds } = await draftWithVideos(env, futureBr(days), 1);
  const all = ['facebook', 'youtube', 'instagram', 'tiktok'];
  await env.api.patch(`/api/batches/${id}`).send({ platforms: Object.fromEntries(all.map((p) => [p, platforms.includes(p)])) }).expect(200);
  if (withCover) await env.api.put(`/api/batches/${id}/items/${itemIds[0]}/cover`).attach('file', fx.cover).expect(200);
  const r = await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.tasks as any[];
}

const task = (env: Env) => env.ctx.modes.real.tasks.all()[0];

describe('YouTube (videos.insert retomável + publishAt)', () => {
  function youtubeApi(f: ReturnType<typeof fakeFetch>, state: { publishAt?: string; processing: string; privacy: string }) {
    f.on('POST', /upload\/youtube\/v3\/videos\?uploadType=resumable/, (_u, _i, body) => {
      state.publishAt = JSON.parse(body.toString()).status.publishAt;
      return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESSAO1' } });
    });
    f.on('PUT', /upload_id=SESSAO1/, (_u, init) => {
      if (String(init.headers['Content-Range']).startsWith('bytes */')) return new Response(null, { status: 308 });
      return json({ id: 'YT_VIDEO_1' });
    });
    f.on('GET', /youtube\/v3\/videos\?part=/, () =>
      json({ items: [{ id: 'YT_VIDEO_1', status: { privacyStatus: state.privacy, publishAt: state.publishAt }, processingDetails: { processingStatus: state.processing }, snippet: { title: 't', description: 'd', categoryId: '22' } }] }),
    );
    f.on('POST', /thumbnails\/set\?videoId=YT_VIDEO_1/, () => json({ items: [{}] }));
  }

  it('envia, confirma o agendamento pelo ID, aplica a capa após o processamento e confirma a publicação', async () => {
    const f = fakeFetch();
    const st = { processing: 'processing', privacy: 'private' } as any;
    youtubeApi(f, st);
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['youtube'], 5, true);
    expect(t0.accountName).toBe('Meu Canal');
    await env.worker.drain();

    const init = f.calls.find((c) => c.url.includes('uploadType=resumable'))!;
    const meta = JSON.parse(init.body.toString());
    expect(meta.status).toEqual({ privacyStatus: 'private', publishAt: new Date(t0.plannedAt).toISOString(), selfDeclaredMadeForKids: false });
    expect(meta.snippet.title).toBe('YT título 1');
    const upload = f.calls.find((c) => c.method === 'PUT' && !String(c.headers['Content-Range']).startsWith('bytes */'))!;
    expect(upload.body.length).toBe(fs.statSync(fx.vertical).size);

    let t = task(env);
    expect(t.state).toBe('scheduled_remote');
    expect(t.remoteId).toBe('YT_VIDEO_1');
    expect(t.cover.state).toBe('pending');

    // Capa só depois de processingStatus=succeeded
    env.clock.advance(3 * 60_000);
    await env.worker.drain();
    expect(f.calls.some((c) => c.url.includes('thumbnails/set'))).toBe(false);
    st.processing = 'succeeded';
    env.clock.advance(3 * 60_000);
    await env.worker.drain();
    t = task(env);
    expect(t.cover.state).toBe('applied');
    expect(f.calls.find((c) => c.url.includes('thumbnails/set'))!.headers['Content-Type']).toBe('image/jpeg');

    st.privacy = 'public';
    env.clock.set(t.plannedAt);
    await env.worker.drain();
    expect(task(env).state).toBe('published');
    // Nenhum token vaza para o frontend
    const dto = JSON.stringify((await env.api.get('/api/tasks')).body) + JSON.stringify((await env.api.get('/api/connections')).body);
    expect(dto).not.toMatch(/ya29.teste|EAApage|EAAuser|refresh_token|tokensEnc|tokenEnc/);
  });

  it('cota do projeto esgotada: espera a renovação sem gastar tentativas', async () => {
    const f = fakeFetch();
    f.on('POST', /uploadType=resumable/, () => json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403));
    const env = await realEnv(f);
    await confirmOnly(env, ['youtube']);
    await env.worker.drain();
    const t = task(env);
    expect(t.lastError).toMatch(/cota diária do PROJETO/);
    expect(t.attempts).toBe(0);
    expect(new Date(t.nextRunAt!).getTime() - Date.now()).toBeGreaterThan(60_000);
  });

  it('limite do canal (uploadLimitExceeded) é tratado separado da cota do projeto', async () => {
    const f = fakeFetch();
    f.on('POST', /uploadType=resumable/, () => json({ error: { code: 400, errors: [{ reason: 'uploadLimitExceeded' }] } }, 400));
    const env = await realEnv(f);
    await confirmOnly(env, ['youtube']);
    await env.worker.drain();
    expect(task(env).lastError).toMatch(/CANAL atingiu o limite/);
  });

  it('timeout no upload: consulta a sessão pelo ID antes de repetir e não envia de novo', async () => {
    const f = fakeFetch();
    const st = { processing: 'processing', privacy: 'private' } as any;
    youtubeApi(f, st);
    let failUpload = true;
    let sessionDone = false;
    f.on('PUT', /upload_id=SESSAO1/, (_u, init) => {
      if (String(init.headers['Content-Range']).startsWith('bytes */')) return sessionDone ? json({ id: 'YT_VIDEO_1' }) : new Response(null, { status: 308 });
      if (failUpload) {
        failUpload = false;
        sessionDone = true; // o Google recebeu tudo, mas a resposta se perdeu
        throw new TypeError('socket hang up');
      }
      return json({ id: 'YT_VIDEO_1' });
    });
    const env = await realEnv(f);
    await confirmOnly(env, ['youtube']);
    await env.worker.drain();
    expect(task(env).remote.needsReconcile).toBe(true);
    env.clock.advance(10 * 60_000);
    await env.worker.drain();
    const t = task(env);
    expect(t.state).toBe('scheduled_remote');
    const fullUploads = f.calls.filter((c) => c.method === 'PUT' && !String(c.headers['Content-Range']).startsWith('bytes */'));
    expect(fullUploads).toHaveLength(1);
  });

  it('nunca envia quando o horário está a menos de 5 minutos (publishAt passado publicaria na hora)', async () => {
    const f = fakeFetch();
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['youtube']);
    env.clock.set(new Date(new Date(t0.plannedAt).getTime() - 2 * 60_000).toISOString());
    await env.worker.drain();
    expect(task(env).state).toBe('late');
    expect(f.calls).toHaveLength(0);
  });
});

describe('Facebook Reels (video_reels start/upload/finish)', () => {
  function fbApi(f: ReturnType<typeof fakeFetch>, s: { publish: string; uploaded?: boolean }) {
    f.on('POST', /graph\.facebook\.com\/v27\.0\/PAGE1\/video_reels$/, (_u, _i, body) => {
      const p = new URLSearchParams(body.toString());
      if (p.get('upload_phase') === 'start') return json({ video_id: 'FBV1', upload_url: 'https://rupload.facebook.com/video-upload/v27.0/FBV1' });
      return json({ success: true });
    });
    f.on('POST', /rupload\.facebook\.com\/video-upload\/v27\.0\/FBV1/, () => {
      s.uploaded = true;
      return json({ success: true });
    });
    f.on('GET', /graph\.facebook\.com\/v27\.0\/FBV1\?/, () =>
      json({ status: { video_status: 'processing', uploading_phase: s.uploaded ? { status: 'complete', bytes_transferred: fs.statSync(fx.vertical).size } : { status: 'not_started', bytes_transferred: 0 }, publishing_phase: { publish_status: s.publish } } }),
    );
    f.on('DELETE', /graph\.facebook\.com\/v27\.0\/FBV1\?/, () => json({ success: true }));
  }

  it('fora da janela de 29 dias: fica na fila do app sem chamar a Meta', async () => {
    const f = fakeFetch();
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['facebook'], 40);
    await env.worker.drain();
    const t = task(env);
    expect(t.state).toBe('queued');
    expect(t.delayNote).toMatch(/29 dias/);
    expect(new Date(t.nextRunAt!).getTime()).toBeLessThan(new Date(t0.plannedAt).getTime());
    expect(f.calls).toHaveLength(0);
  });

  it('dentro da janela: agenda nativamente com SCHEDULED e confirma publish_status=scheduled', async () => {
    const f = fakeFetch();
    const s = { publish: 'draft' };
    fbApi(f, s);
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['facebook'], 5);
    await env.worker.drain();
    const finish = f.calls.map((c) => new URLSearchParams(c.body.toString())).find((p) => p.get('upload_phase') === 'finish')!;
    expect(finish.get('video_state')).toBe('SCHEDULED');
    expect(Number(finish.get('scheduled_publish_time'))).toBe(new Date(t0.plannedAt).getTime() / 1000);
    expect(finish.get('title')).toBe('FB título 1');
    expect(finish.get('description')).toBe('FB descrição 1');
    const up = f.calls.find((c) => c.url.includes('rupload'))!;
    expect(up.headers.Authorization).toBe('OAuth EAApage');
    expect(up.headers.file_size).toBe(String(fs.statSync(fx.vertical).size));
    expect(task(env).state).toBe('processing'); // ainda sem confirmação remota
    s.publish = 'scheduled';
    env.clock.advance(2 * 60_000);
    await env.worker.drain();
    expect(task(env).state).toBe('scheduled_remote');
    // Cancelamento confirma com a Meta (DELETE) antes de mostrar "Cancelado"
    const c = await env.api.post(`/api/tasks/${t0.id}/cancel`).set('Idempotency-Key', idemKey()).expect(200);
    expect(c.body.state).toBe('cancelled');
    expect(f.calls.some((x) => x.method === 'DELETE')).toBe(true);
  });

  it('limite de Reels (erro 613) vira nova tentativa espaçada', async () => {
    const f = fakeFetch();
    f.on('POST', /PAGE1\/video_reels$/, () => json({ error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } }, 400));
    const env = await realEnv(f);
    await confirmOnly(env, ['facebook'], 5);
    await env.worker.drain();
    const t = task(env);
    expect(t.state).toBe('processing');
    expect(t.attempts).toBe(1);
    expect(new Date(t.nextRunAt!).getTime() - env.clock.now().getTime()).toBeGreaterThanOrEqual(14 * 60_000);
  });
});

describe('Instagram Reels (container + media_publish no horário)', () => {
  function igApi(f: ReturnType<typeof fakeFetch>, s: { status: string; publishFails?: boolean }) {
    f.on('GET', /IG1\/content_publishing_limit/, () => json({ data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] }));
    f.on('POST', /v27\.0\/IG1\/media$/, () => json({ id: 'CONT1' }));
    f.on('GET', /v27\.0\/CONT1\?/, () => json({ status_code: s.status }));
    f.on('POST', /v27\.0\/IG1\/media_publish$/, () => {
      if (s.publishFails) {
        s.publishFails = false;
        s.status = 'PUBLISHED';
        throw new TypeError('timeout');
      }
      return json({ id: 'IGMEDIA1' });
    });
    f.on('GET', /v27\.0\/IGMEDIA1\?/, () => json({ permalink: 'https://www.instagram.com/reel/abc/' }));
  }

  it('cria o container perto do horário com link temporário e publica às 12:00', async () => {
    const f = fakeFetch();
    const s = { status: 'IN_PROGRESS' };
    igApi(f, s);
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['instagram'], 3);
    await env.worker.drain();
    expect(task(env).state).toBe('queued');
    expect(f.calls).toHaveLength(0);

    env.clock.set(new Date(new Date(t0.plannedAt).getTime() - 60 * 60_000).toISOString());
    await env.worker.drain();
    const create = new URLSearchParams(f.calls.find((c) => /IG1\/media$/.test(c.url))!.body.toString());
    expect(create.get('media_type')).toBe('REELS');
    expect(create.get('caption')).toBe('IG legenda 1 #teste');
    expect(create.get('thumb_offset')).toBe('0');
    const videoUrl = create.get('video_url')!;
    expect(videoUrl).toMatch(/^https:\/\/tunel\.exemplo\.dev\/public\/media\//);
    expect(task(env).state).toBe('processing');

    // A Meta (de fora, pelo túnel) consegue baixar SÓ esse arquivo
    const p = new URL(videoUrl).pathname;
    const got = await env.api.get(p).set('Host', 'tunel.exemplo.dev').set('X-Forwarded-For', '157.240.0.1').expect(200);
    expect(Number(got.headers['content-length'])).toBe(fs.statSync(fx.vertical).size);
    await env.api.get('/api/tasks').set('Host', 'tunel.exemplo.dev').expect(403);
    await env.api.get(p.replace(/[^/]+$/, 'outro.mp4')).set('Host', 'tunel.exemplo.dev').expect(404);

    s.status = 'FINISHED';
    env.clock.advance(2 * 60_000);
    await env.worker.drain();
    expect(f.calls.some((c) => c.url.includes('media_publish'))).toBe(false); // ainda não é meio-dia
    env.clock.set(t0.plannedAt);
    await env.worker.drain();
    const t = task(env);
    expect(t.state).toBe('published');
    expect(t.remoteUrl).toBe('https://www.instagram.com/reel/abc/');
  });

  it('timeout no media_publish: consulta o container e não publica duas vezes', async () => {
    const f = fakeFetch();
    const s = { status: 'FINISHED', publishFails: true };
    igApi(f, s);
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['instagram'], 3);
    env.clock.set(t0.plannedAt);
    await env.worker.drain();
    env.clock.advance(5 * 60_000);
    await env.worker.drain();
    const t = task(env);
    expect(t.state).toBe('published');
    expect(f.calls.filter((c) => c.url.includes('media_publish'))).toHaveLength(1);
    expect(t.history.some((h) => /já estava publicado/.test(h.message))).toBe(true);
  });

  it('ainda processando ao meio-dia: registra o atraso e vira "Atrasado" após a tolerância', async () => {
    const f = fakeFetch();
    igApi(f, { status: 'IN_PROGRESS' });
    const env = await realEnv(f);
    const [t0] = await confirmOnly(env, ['instagram'], 3);
    env.clock.set(new Date(new Date(t0.plannedAt).getTime() + 60_000).toISOString());
    await env.worker.drain();
    expect(task(env).delayNote).toMatch(/ainda estava em processamento/);
    env.clock.advance(25 * 60_000);
    await env.worker.tick();
    expect(task(env).state).toBe('late');
  });
});

describe('TikTok', () => {
  it('com video.upload aprovado: envia à caixa de entrada e mostra "Enviado ao TikTok" (não "Publicado")', async () => {
    const f = fakeFetch();
    f.on('POST', /open\.tiktokapis\.com\/v2\/post\/publish\/inbox\/video\/init\//, (_u, _i, body) => {
      const b = JSON.parse(body.toString());
      expect(b.source_info.source).toBe('FILE_UPLOAD');
      expect(b.source_info.total_chunk_count).toBe(1);
      return json({ data: { publish_id: 'v_inbox_1', upload_url: 'https://open-upload.tiktokapis.com/upload/?id=1' }, error: { code: 'ok' } });
    });
    f.on('PUT', /open-upload\.tiktokapis\.com/, () => new Response(null, { status: 201 }));
    f.on('POST', /status\/fetch/, () => json({ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } }));
    // O access token dura 2 h: com o relógio 3 dias à frente, o app precisa renovar (e o refresh token gira).
    f.on('POST', /open\.tiktokapis\.com\/v2\/oauth\/token\//, (_u, _i, body) => {
      expect(new URLSearchParams(body.toString()).get('grant_type')).toBe('refresh_token');
      return json({ access_token: 'act2', refresh_token: 'rft2', expires_in: 7200, refresh_expires_in: 15552000, open_id: 'o1', scope: 'user.info.basic,video.upload' });
    });
    const env = await realEnv(f, { tiktok: { clientKey: 'k', clientSecret: 's', redirectUri: 'https://x/cb', uploadApproved: true, directPostApproved: false, inboxLeadMinutes: 30 } });
    const mc = env.ctx.modes.real;
    await writeTokens(env.ctx, mc, 'tiktok', { access_token: 'act', refresh_token: 'rft', expires_at: Date.now() + 86400_000, refresh_expires_at: Date.now() + 86400_000 * 100, open_id: 'o1', scope: 'user.info.basic,video.upload' });
    await mc.connections.mutate((d) => {
      d.tiktok = { ...d.tiktok, accountId: 'o1', accountName: 'eu_tiktok', scopes: ['user.info.basic', 'video.upload'] };
    });
    const [t0] = await confirmOnly(env, ['tiktok'], 3);
    expect(t0.state).toBe('queued');
    env.clock.set(new Date(new Date(t0.plannedAt).getTime() - 30 * 60_000).toISOString());
    await env.worker.drain();
    const t = task(env);
    expect(t.lastError).toBeUndefined();
    expect(t.state).toBe('manual_action');
    expect(t.manualReason).toBe('tiktok_inbox');
    const put = f.calls.find((c) => c.method === 'PUT')!;
    const size = fs.statSync(fx.vertical).size;
    expect(put.headers['Content-Range']).toBe(`bytes 0-${size - 1}/${size}`);
    const stored = env.ctx.vault.decrypt<any>(mc.connections.get().tiktok!.tokensEnc!, 'tiktok');
    expect(stored.refresh_token).toBe('rft2');
    // Arquivo de conexões no disco não contém tokens em texto puro
    const raw = fs.readFileSync(`${mc.dir}/connections.json`, 'utf8');
    expect(raw).not.toMatch(/act2|rft2|EAApage|ya29/);
  });
});
