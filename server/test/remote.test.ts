// Acesso remoto: interface na Vercel -> Function de proxy -> backend.
// Testa login, proteção das rotas, links assinados de upload/mídia, CORS,
// rotas OAuth e a própria Function de proxy (api/proxy.ts) contra o backend real.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/session.js';
import { fixtures, futureBr, idemKey, makeEnv, type Env } from './helpers.js';

const fx = fixtures();
const SECRET = 'segredo-do-proxy-para-testes-123456';
const APP = 'https://agendador-junior.vercel.app';
const PUBLIC = 'https://api.exemplo.dev';
const PASSWORD = 'senha-de-teste-bem-longa';
const HASH = hashPassword(PASSWORD);

function remoteEnv(mode: 'demo' | 'real' = 'demo') {
  return makeEnv({
    mode,
    config: {
      proxySecret: SECRET,
      appUrl: APP,
      publicBaseUrl: PUBLIC,
      appPasswordHash: HASH,
      google: { clientId: 'cliente-google', clientSecret: 'x', redirectUri: `${PUBLIC}/api/oauth/youtube/callback` },
      meta: {
        appId: 'app-meta', appSecret: 'x', redirectUri: `${PUBLIC}/api/oauth/facebook/callback`, graphVersion: 'v27.0', configId: '',
        reelsCustomCover: false, allowDirectPublishFallback: false, igResumable: false, igContainerLeadMinutes: 60,
      },
    },
  });
}

/** Simula um pedido vindo da Function de proxy da Vercel. */
const viaProxy = (r: any, cookie?: string) => {
  r.set('x-agendador-proxy', SECRET).set('X-Forwarded-For', '200.1.2.3').set('Origin', APP);
  return cookie ? r.set('Cookie', cookie) : r;
};

async function login(env: Env): Promise<string> {
  const res = await viaProxy(env.api.post('/api/auth/login')).send({ password: PASSWORD }).expect(200);
  const set = res.headers['set-cookie'][0] as string;
  expect(set).toMatch(/HttpOnly/);
  expect(set).toMatch(/Secure/);
  expect(set).toMatch(/SameSite=Lax/);
  return set.split(';')[0];
}

describe('acesso remoto protegido', () => {
  it('sem o segredo do proxy, nada de /api é acessível pela internet', async () => {
    const env = await remoteEnv();
    await env.api.get('/api/tasks').set('X-Forwarded-For', '1.2.3.4').expect(403);
    await env.api.get('/api/auth/session').set('Host', 'api.exemplo.dev').expect(403);
    await env.api.get('/api/tasks').set('x-agendador-proxy', 'errado').set('X-Forwarded-For', '1.2.3.4').expect(403);
  });

  it('com o segredo, exige login; senha errada é recusada e limitada', async () => {
    const env = await remoteEnv();
    const s = (await viaProxy(env.api.get('/api/auth/session')).expect(200)).body;
    expect(s).toEqual({ loginRequired: true, authenticated: false, loginConfigured: true, directLinks: true });
    const denied = await viaProxy(env.api.get('/api/tasks')).expect(401);
    expect(denied.body.code).toBe('login_required');
    await viaProxy(env.api.get('/api/media/qualquer')).expect(401);
    await viaProxy(env.api.get('/api/connections/youtube/start')).expect(401);
    await viaProxy(env.api.post('/api/auth/login')).send({ password: 'errada' }).expect(401);
    for (let i = 0; i < 4; i++) await viaProxy(env.api.post('/api/auth/login')).send({ password: 'errada' });
    await viaProxy(env.api.post('/api/auth/login')).send({ password: PASSWORD }).expect(429);
  });

  it('cookie forjado ou expirado não passa', async () => {
    const env = await remoteEnv();
    await viaProxy(env.api.get('/api/tasks'), 'agj_sessao=abc.def').expect(401);
    const cookie = await login(env);
    await viaProxy(env.api.get('/api/tasks'), cookie).expect(200);
    env.clock.advance(8 * 86400_000); // SESSION_DAYS=7
    await viaProxy(env.api.get('/api/tasks'), cookie).expect(401);
  });

  it('no localhost continua sem login (modo local preservado)', async () => {
    const env = await remoteEnv();
    const s = (await env.api.get('/api/auth/session').expect(200)).body;
    expect(s.loginRequired).toBe(false);
    expect(s.authenticated).toBe(true);
    await env.api.get('/api/tasks').expect(200);
  });
});

describe('lote de 5 vídeos pela interface hospedada (uploads direto no backend)', () => {
  it('monta o lote com datas consecutivas às 12:00 usando links assinados', async () => {
    const env = await remoteEnv();
    const cookie = await login(env);
    const start = futureBr(12);
    const b = (await viaProxy(env.api.post('/api/batches'), cookie).set('Idempotency-Key', idemKey()).send({ startDate: start }).expect(201)).body;
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `v${i + 1}.mp4`, size: fs.statSync(fx.vertical).size }));
    const reserved = (await viaProxy(env.api.post(`/api/batches/${b.id}/items`), cookie).send({ files }).expect(201)).body;
    for (const it of reserved.batch.items) {
      expect(it.uploadUrl.startsWith(`${PUBLIC}/direct/upload/`)).toBe(true);
      const path = new URL(it.uploadUrl).pathname;
      // o navegador envia direto ao backend (outra origem), sem cookie
      const up = await env.api.put(path).set('Host', 'api.exemplo.dev').set('X-Forwarded-For', '200.1.2.3').set('Origin', APP).attach('file', fx.vertical).expect(200);
      expect(up.headers['access-control-allow-origin']).toBe(APP);
    }
    const final = (await viaProxy(env.api.get(`/api/batches/${b.id}`), cookie).expect(200)).body;
    expect(final.items.map((i: any) => i.scheduledLocal.slice(-5))).toEqual(['12:00', '12:00', '12:00', '12:00', '12:00']);
    const t = final.items.map((i: any) => new Date(i.scheduledAt).getTime());
    for (let i = 1; i < 5; i++) expect(t[i] - t[i - 1]).toBe(86_400_000);
    expect(final.items[0].scheduledLocal).toBe(`${start} 12:00`);
    // prévia por link assinado direto no backend
    const mediaUrl: string = final.items[0].media.url;
    expect(mediaUrl.startsWith(`${PUBLIC}/direct/media/`)).toBe(true);
    const got = await env.api.get(new URL(mediaUrl).pathname).set('Host', 'api.exemplo.dev').set('X-Forwarded-For', '200.1.2.3').expect(200);
    expect(Number(got.headers['content-length'])).toBe(fs.statSync(fx.vertical).size);
  });

  it('links assinados: adulterado ou vencido é recusado; CORS só para APP_URL', async () => {
    const env = await remoteEnv();
    const cookie = await login(env);
    const b = (await viaProxy(env.api.post('/api/batches'), cookie).send({ startDate: futureBr(5) }).expect(201)).body;
    const r = (await viaProxy(env.api.post(`/api/batches/${b.id}/items`), cookie).send({ files: [{ name: 'a.mp4' }] }).expect(201)).body;
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
    const cookie = await login(env);
    const yt = await viaProxy(env.api.get(`/api/connections/youtube/start?return=${encodeURIComponent(APP)}`), cookie).expect(302);
    const g = new URL(yt.headers.location);
    expect(g.origin).toBe('https://accounts.google.com');
    expect(g.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/oauth/youtube/callback`);
    expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    expect(g.searchParams.get('access_type')).toBe('offline');
    expect(g.searchParams.get('state')).toBeTruthy();
    const fb = await viaProxy(env.api.get('/api/connections/facebook/start'), cookie).expect(302);
    const f = new URL(fb.headers.location);
    expect(f.pathname).toBe('/v27.0/dialog/oauth');
    expect(f.searchParams.get('scope')).toContain('instagram_content_publish');
    const tt = await viaProxy(env.api.get('/api/connections/tiktok/start'), cookie).expect(409);
    expect(tt.body.error).toMatch(/TIKTOK_REDIRECT_URI \(HTTPS\)/);

    // Retorno do provedor chega direto ao backend (sem cookie): state inválido é recusado
    const bad = await env.api.get('/api/oauth/youtube/callback?state=forjado&code=x').set('Host', 'api.exemplo.dev').set('X-Forwarded-For', '142.250.0.1').expect(400);
    expect(bad.text).toMatch(/Estado OAuth inválido/);
    // Usuário cancela no Google: volta para a interface na Vercel com o erro
    const state = g.searchParams.get('state')!;
    const back = await env.api.get(`/api/oauth/youtube/callback?state=${state}&error=access_denied`).set('Host', 'api.exemplo.dev').expect(302);
    expect(back.headers.location).toBe(`${APP}/#/conexoes?erro=access_denied`);
    // state é de uso único
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

  it('encaminha com o segredo, repassa cookie de sessão e protege as rotas', async () => {
    const s = await proxy.GET(req('GET', 'auth/session'));
    expect(await s.json()).toMatchObject({ loginRequired: true, authenticated: false });
    expect((await proxy.GET(req('GET', 'tasks'))).status).toBe(401);
    const l = await proxy.POST(req('POST', 'auth/login', { body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } }));
    expect(l.status).toBe(200);
    const cookie = l.headers.get('set-cookie')!.split(';')[0];
    const t = await proxy.GET(req('GET', 'tasks', { headers: { cookie } }));
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    const b = await proxy.POST(req('POST', 'batches', { body: JSON.stringify({ startDate: futureBr(9) }), headers: { cookie, 'content-type': 'application/json' } }));
    expect(b.status).toBe(201);
  });

  it('repassa o 302 do OAuth sem segui-lo e recusa caminhos suspeitos', async () => {
    const l = await proxy.POST(req('POST', 'auth/login', { body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } }));
    const cookie = l.headers.get('set-cookie')!.split(';')[0];
    await env.ctx.settings.mutate((s) => (s.mode = 'real'));
    const r = await proxy.GET(req('GET', 'connections/youtube/start', { headers: { cookie } }));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect((await proxy.GET(req('GET', '../segredo'))).status).toBe(400);
  });

  it('sem BACKEND_URL responde 503 com mensagem clara', async () => {
    const saved = process.env.BACKEND_URL;
    delete process.env.BACKEND_URL;
    const r = await proxy.GET(req('GET', 'auth/session'));
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('backend_not_configured');
    process.env.BACKEND_URL = saved;
  });
});
