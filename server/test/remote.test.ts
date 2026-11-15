// Acesso remoto: interface na Vercel -> Function de proxy -> backend.
// Sem login: a interface abre direto. O backend só aceita /api vindo do proxy
// (segredo BACKEND_PROXY_SECRET). Testa também links assinados de upload/mídia,
// CORS, rotas OAuth e a própria Function de proxy (api/proxy.ts).
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtures, futureBr, idemKey, makeEnv, type Env } from './helpers.js';

const fx = fixtures();
const SECRET = 'segredo-do-proxy-para-testes-123456';
const APP = 'https://agendador-junior.vercel.app';
const PUBLIC = 'https://api.exemplo.dev';

function remoteEnv(mode: 'demo' | 'real' = 'demo') {
  return makeEnv({
    mode,
    config: {
      proxySecret: SECRET,
      appUrl: APP,
      publicBaseUrl: PUBLIC,
      google: { clientId: 'cliente-google', clientSecret: 'x', redirectUri: `${PUBLIC}/api/oauth/youtube/callback` },
      meta: {
        appId: 'app-meta', appSecret: 'x', redirectUri: `${PUBLIC}/api/oauth/facebook/callback`, graphVersion: 'v27.0', configId: '',
        reelsCustomCover: false, allowDirectPublishFallback: false, igResumable: false, igContainerLeadMinutes: 60,
      },
      // Independente do .env local: TikTok sem credenciais e no modo pessoal
      tiktok: { clientKey: '', clientSecret: '', redirectUri: '', uploadApproved: false, directPostApproved: false, inboxLeadMinutes: 30 },
    },
  });
}

/** Simula um pedido vindo da Function de proxy da Vercel. */
const viaProxy = (r: any) => r.set('x-agendador-proxy', SECRET).set('X-Forwarded-For', '200.1.2.3').set('Origin', APP);

describe('acesso remoto sem login', () => {
  it('pelo proxy, a interface acessa a API direto, sem senha nem cookie', async () => {
    const env = await remoteEnv();
    const s = (await viaProxy(env.api.get('/api/settings')).expect(200)).body;
    expect(s.remoteAccess).toBe(true);
    expect(s.directLinks).toBe(true);
    const t = await viaProxy(env.api.get('/api/tasks')).expect(200);
    expect(t.headers['set-cookie']).toBeUndefined();
    await viaProxy(env.api.get('/api/connections')).expect(200);
    // rotas de login não existem mais
    await viaProxy(env.api.get('/api/auth/session')).expect(404);
    await viaProxy(env.api.post('/api/auth/login')).send({ password: 'x' }).expect(404);
  });

  it('sem o segredo do proxy, nada de /api é acessível pela internet', async () => {
    const env = await remoteEnv();
    await env.api.get('/api/tasks').set('X-Forwarded-For', '1.2.3.4').expect(403);
    await env.api.get('/api/settings').set('Host', 'api.exemplo.dev').expect(403);
    await env.api.get('/api/tasks').set('x-agendador-proxy', 'errado').set('X-Forwarded-For', '1.2.3.4').expect(403);
    // escrita de outra origem continua bloqueada mesmo pelo proxy
    await env.api.post('/api/batches').set('x-agendador-proxy', SECRET).set('X-Forwarded-For', '1.2.3.4').set('Origin', 'https://site-malicioso.example').send({ startDate: futureBr(3) }).expect(403);
  });

  it('no localhost continua igual', async () => {
    const env = await remoteEnv();
    const s = (await env.api.get('/api/settings').expect(200)).body;
    expect(s.remoteAccess).toBe(false);
    await env.api.get('/api/tasks').expect(200);
  });
});

describe('lote de 5 vídeos pela interface hospedada (uploads direto no backend)', () => {
  it('monta o lote com datas consecutivas às 12:00 usando links assinados', async () => {
    const env = await remoteEnv();
    const start = futureBr(12);
    const b = (await viaProxy(env.api.post('/api/batches')).set('Idempotency-Key', idemKey()).send({ startDate: start }).expect(201)).body;
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `v${i + 1}.mp4`, size: fs.statSync(fx.vertical).size }));
    const reserved = (await viaProxy(env.api.post(`/api/batches/${b.id}/items`)).send({ files }).expect(201)).body;
    for (const it of reserved.batch.items) {
      expect(it.uploadUrl.startsWith(`${PUBLIC}/direct/upload/`)).toBe(true);
      const path = new URL(it.uploadUrl).pathname;
      const up = await env.api.put(path).set('Host', 'api.exemplo.dev').set('X-Forwarded-For', '200.1.2.3').set('Origin', APP).attach('file', fx.vertical).expect(200);
      expect(up.headers['access-control-allow-origin']).toBe(APP);
    }
    const final = (await viaProxy(env.api.get(`/api/batches/${b.id}`)).expect(200)).body;
    expect(final.items.map((i: any) => i.scheduledLocal.slice(-5))).toEqual(['12:00', '12:00', '12:00', '12:00', '12:00']);
    const t = final.items.map((i: any) => new Date(i.scheduledAt).getTime());
    for (let i = 1; i < 5; i++) expect(t[i] - t[i - 1]).toBe(86_400_000);
    expect(final.items[0].scheduledLocal).toBe(`${start} 12:00`);
    const mediaUrl: string = final.items[0].media.url;
    expect(mediaUrl.startsWith(`${PUBLIC}/direct/media/`)).toBe(true);
    const got = await env.api.get(new URL(mediaUrl).pathname).set('Host', 'api.exemplo.dev').set('X-Forwarded-For', '200.1.2.3').expect(200);
    expect(Number(got.headers['content-length'])).toBe(fs.statSync(fx.vertical).size);
  });

  it('links assinados: adulterado ou vencido é recusado; CORS só para APP_URL', async () => {
    const env = await remoteEnv();
    const b = (await viaProxy(env.api.post('/api/batches')).send({ startDate: futureBr(5) }).expect(201)).body;
    const r = (await viaProxy(env.api.post(`/api/batches/${b.id}/items`)).send({ files: [{ name: 'a.mp4' }] }).expect(201)).body;
    const path = new URL(r.batch.items[0].uploadUrl).pathname;
    const ext = { Host: 'api.exemplo.dev', 'X-Forwarded-For': '9.9.9.9' };
    await env.api.put(path.slice(0, -3) + 'xyz').set(ext).expect(403); // recusa antes de ler o corpo
    await env.api.options(path).set(ext).set('Origin', APP).expect(204);
    await env.api.options(path).set(ext).set('Origin', 'https://outro-site.example').expect(403);
    env.clock.advance(4 * 3600_000);
    const expired = await env.api.put(path).set(ext).expect(403);
    expect(expired.body.error).toMatch(/expirado ou inválido/);
  });
});

describe('rotas OAuth (sem chamar os provedores)', () => {
  it('início do OAuth pelo proxy redireciona com state, PKCE e callback HTTPS do backend', async () => {
    const env = await remoteEnv('real');
    const yt = await viaProxy(env.api.get(`/api/connections/youtube/start?return=${encodeURIComponent(APP)}`)).expect(302);
    const g = new URL(yt.headers.location);
    expect(g.origin).toBe('https://accounts.google.com');
    expect(g.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/oauth/youtube/callback`);
    expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    expect(g.searchParams.get('access_type')).toBe('offline');
    expect(g.searchParams.get('state')).toBeTruthy();
    const fb = await viaProxy(env.api.get('/api/connections/facebook/start')).expect(302);
    const f = new URL(fb.headers.location);
    expect(f.pathname).toBe('/v27.0/dialog/oauth');
    expect(f.searchParams.get('scope')).toContain('instagram_content_publish');
    const tt = await viaProxy(env.api.get('/api/connections/tiktok/start')).expect(409);
    expect(tt.body.error).toMatch(/TIKTOK_REDIRECT_URI \(HTTPS\)/);

    const bad = await env.api.get('/api/oauth/youtube/callback?state=forjado&code=x').set('Host', 'api.exemplo.dev').set('X-Forwarded-For', '142.250.0.1').expect(400);
    expect(bad.text).toMatch(/Estado OAuth inválido/);
    const state = g.searchParams.get('state')!;
    const back = await env.api.get(`/api/oauth/youtube/callback?state=${state}&error=access_denied`).set('Host', 'api.exemplo.dev').expect(302);
    expect(back.headers.location).toBe(`${APP}/#/conexoes?erro=access_denied`);
    await env.api.get(`/api/oauth/youtube/callback?state=${state}&code=x`).set('Host', 'api.exemplo.dev').expect(400);
  });
});

describe('Function de proxy da Vercel (api/proxy.ts) contra o backend real', () => {
  let env: Env;
  let server: import('node:http').Server;
  let proxy: typeof import('../../api/proxy.js');
  beforeAll(async () => {
    env = await remoteEnv();
    server = env.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    process.env.BACKEND_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.BACKEND_PROXY_SECRET = SECRET;
    proxy = await import('../../api/proxy.js');
  });
  afterAll(() => {
    server.close();
    delete process.env.BACKEND_URL;
    delete process.env.BACKEND_PROXY_SECRET;
  });

  const req = (method: string, path: string, init: RequestInit = {}) =>
    new Request(`${APP}/api/proxy?__path=${path}`, { method, ...init, headers: { origin: APP, 'x-forwarded-for': '200.1.2.3', ...(init.headers as any) } });

  it('encaminha com o segredo e a interface funciona direto, sem cookie', async () => {
    const s = await proxy.GET(req('GET', 'settings'));
    expect(s.status).toBe(200);
    expect(await s.json()).toMatchObject({ remoteAccess: true, directLinks: true });
    const t = await proxy.GET(req('GET', 'tasks', { headers: { cookie: 'qualquer=1' } }));
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    expect(t.headers.get('set-cookie')).toBeNull();
    const b = await proxy.POST(req('POST', 'batches', { body: JSON.stringify({ startDate: futureBr(9) }), headers: { 'content-type': 'application/json' } }));
    expect(b.status).toBe(201);
  });

  it('com segredo errado na Vercel, o backend recusa', async () => {
    process.env.BACKEND_PROXY_SECRET = 'outro-segredo';
    expect((await proxy.GET(req('GET', 'settings'))).status).toBe(403);
    process.env.BACKEND_PROXY_SECRET = SECRET;
  });

  it('repassa o 302 do OAuth sem segui-lo e recusa caminhos suspeitos', async () => {
    await env.ctx.settings.mutate((s) => (s.mode = 'real'));
    const r = await proxy.GET(req('GET', 'connections/youtube/start'));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect((await proxy.GET(req('GET', '../segredo'))).status).toBe(400);
  });

  it('sem BACKEND_URL responde 503 com mensagem clara', async () => {
    const saved = process.env.BACKEND_URL;
    delete process.env.BACKEND_URL;
    const r = await proxy.GET(req('GET', 'settings'));
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('backend_not_configured');
    process.env.BACKEND_URL = saved;
  });
});
