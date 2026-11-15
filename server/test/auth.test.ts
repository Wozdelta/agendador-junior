import { TokenVault } from '../src/lib/crypto.js';
import express from 'express';
import request from 'supertest';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/index.js';
import * as configModule from '../src/config.js';
import { database, OWNER } from './supabase-fixture.js';
const email = 'admin@example.com';
let fixture: Awaited<ReturnType<typeof database>>;
let sent: any[] = [];
let authenticatedEmail = email;
let tokenValid = true;
beforeAll(async () => {
  fixture = await database();
}, 30000);
afterAll(async () => fixture?.db.close());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function app() {
  const config = configModule.loadConfig({
    runtime: 'local',
    storage: 'supabase',
    mediaStorage: 'supabase',
    adminEmail: ' ADMIN@EXAMPLE.COM ',
    tokenKey: Buffer.alloc(32, 7).toString('base64'),
    supabase: {
      url: 'https://supabase.test',
      publishableKey: 'test-publishable',
      secretKey: 'test-secret',
    },
  });
  vi.spyOn(configModule, 'loadConfig').mockReturnValue(config);
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    const method = init?.method ?? 'GET';
    if (url.pathname === '/auth/v1/otp') {
      sent.push(body);
      return Response.json({});
    }
    const user = {
      id: OWNER,
      email: authenticatedEmail,
      email_confirmed_at: '2026-11-01T00:00:00Z',
      aud: 'authenticated',
      created_at: '2026-11-01T00:00:00Z',
      app_metadata: {},
      user_metadata: {},
    };
    if (url.pathname === '/auth/v1/verify')
      return body.token === '123456'
        ? Response.json({
            access_token: 'test-access',
            refresh_token: 'test-refresh',
            expires_in: 3600,
            token_type: 'bearer',
            user,
          })
        : Response.json({ msg: 'Invalid code' }, { status: 401 });
    if (url.pathname === '/auth/v1/user')
      return tokenValid ||
        new Headers(init?.headers).get('authorization') === 'Bearer refreshed-access'
        ? Response.json(user)
        : Response.json({ msg: 'expired' }, { status: 401 });
    if (url.pathname === '/auth/v1/token')
      return Response.json({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        expires_in: 3600,
        token_type: 'bearer',
        user,
      });
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (url.pathname === '/rest/v1/rpc/scheduler_load') {
      const { rows } = await fixture.db.query('select scheduler_load($1,$2,$3) value', [
        body.p_owner,
        body.p_mode,
        body.p_name,
      ]);
      return Response.json((rows[0] as any).value);
    }
    if (url.pathname === '/rest/v1/rpc/scheduler_commit') {
      const { rows } = await fixture.db.query(
        'select scheduler_commit($1,$2,$3,$4,$5::jsonb) value',
        [body.p_owner, body.p_mode, body.p_name, body.p_expected, JSON.stringify(body.p_items)],
      );
      return Response.json((rows[0] as any).value);
    }
    if (url.pathname === '/rest/v1/scheduler_sessions') {
      if (method === 'POST') {
        await fixture.db.query(
          'insert into scheduler_sessions(id,owner_id,expires_at) values($1,$2,$3)',
          [body.id, body.owner_id, body.expires_at],
        );
        return new Response(null, { status: 201 });
      }
      const id = url.searchParams.get('id')?.slice(3),
        owner = url.searchParams.get('owner_id')?.slice(3);
      if (method === 'PATCH') {
        await fixture.db.query(
          'update scheduler_sessions set revoked_at=$1 where id=$2 and owner_id=$3',
          [body.revoked_at, id, owner],
        );
        return new Response(null, { status: 204 });
      }
      const { rows } = await fixture.db.query(
        'select id from scheduler_sessions where id=$1 and owner_id=$2 and revoked_at is null and expires_at>now()',
        [id, owner],
      );
      return Response.json(rows[0] ?? null);
    }
    throw new Error(`Unexpected test request ${method} ${url.pathname}`);
  };
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  const app = express();
  app.use(handler);
  return app;
}
it('OTP autorizado, recusa outro e-mail, lote de cinco no banco, importação idempotente, status e logout revogado', async () => {
  sent = [];
  authenticatedEmail = email;
  tokenValid = true;
  const target = app();
  const agent = request.agent(target);
  await agent.get('/api?__path=manual').expect(401);
  await agent
    .post('/api?__path=auth/request-code')
    .send({ email: 'intruso@example.com' })
    .expect(403);
  expect(sent).toHaveLength(0);
  await agent
    .post('/api?__path=auth/request-code')
    .send({ email: '  ADMIN@EXAMPLE.COM ' })
    .expect(200);
  expect(sent[0]).toMatchObject({ email, create_user: false });
  await agent.post('/api?__path=auth/verify-code').send({ email, code: '000000' }).expect(401);
  const login = await agent
    .post('/api?__path=auth/verify-code')
    .send({ email, code: '123456' })
    .expect(200);
  const cookie = login.headers['set-cookie'] as unknown as string[];
  expect(cookie.join(';')).toContain('HttpOnly');
  expect(cookie.join(';')).not.toContain('test-secret');
  await agent.get('/api?__path=auth/session').expect(200, { user: { id: OWNER, email } });
  await agent.get('/api?__path=connections').expect(200);
  await agent.get('/api?__path=tasks').expect(200);
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `auth-v${i}`,
    batchId: 'auth-lote',
    date: `2026-12-${10 + i}`,
    originalName: `video${i}.mp4`,
    title: 'Título de teste',
    description: 'Legenda',
    platforms: { youtube: false, tiktok: false },
  }));
  const ops = rows.map((value) => ({ type: 'insert', value }));
  await agent.post('/api?__path=manual').send({ ops }).expect(200);
  await agent.post('/api?__path=manual').send({ ops }).expect(200);
  expect((await agent.get('/api?__path=manual').expect(200)).body.rows).toHaveLength(5);
  await Promise.all([
    agent
      .post('/api?__path=manual')
      .send({ ops: [{ type: 'patch', id: 'auth-v0', patch: { platforms: { youtube: true } } }] })
      .expect(200),
    agent
      .post('/api?__path=manual')
      .send({ ops: [{ type: 'patch', id: 'auth-v0', patch: { platforms: { tiktok: true } } }] })
      .expect(200),
  ]);
  const saved = (await agent.get('/api?__path=manual')).body.rows.find(
    (x: any) => x.id === 'auth-v0',
  );
  expect(saved.platforms).toEqual({ youtube: true, tiktok: true });
  tokenValid = false;
  const refreshed = await agent.get('/api?__path=manual').expect(200);
  expect(String(refreshed.headers['set-cookie'])).toContain('refreshed-access');
  const encrypted = new TokenVault(Buffer.alloc(32, 7).toString('base64')).encrypt(
    { access_token: 'never-in-browser', refresh_token: 'preserved' },
    'youtube',
  );
  const backup = {
    mode: 'real',
    collections: {
      connections: [
        {
          id: 'doc',
          youtube: {
            tokensEnc: encrypted,
            accountId: 'old-channel',
            accountName: 'Canal preservado',
          },
        },
      ],
    },
  };
  await agent
    .post('/api?__path=migration/legacy')
    .send({
      mode: 'real',
      collections: { connections: [{ id: 'doc', youtube: { tokensEnc: 'invalid' } }] },
    })
    .expect(400);
  const imported = await agent.post('/api?__path=migration/legacy').send(backup).expect(200);
  expect(imported.body.imported.connections).toBe(1);
  expect(
    (await agent.post('/api?__path=migration/legacy').send(backup)).body.imported.connections,
  ).toBe(0);
  const connections = await agent.get('/api?__path=connections').expect(200);
  expect(connections.body.find((x: any) => x.platform === 'youtube').accountName).toBe(
    'Canal preservado',
  );
  expect(JSON.stringify(connections.body)).not.toContain(encrypted);
  expect(JSON.stringify(connections.body)).not.toContain('never-in-browser');
  await agent.post('/api?__path=auth/logout').send({}).expect(200);
  await agent.get('/api?__path=manual').expect(401);
  await request(target)
    .get('/api?__path=manual')
    .set('Cookie', cookie.map((v: string) => v.split(';')[0]).join('; '))
    .expect(401);
});
it('a identidade retornada pelo provedor também precisa ser administradora', async () => {
  tokenValid = true;
  authenticatedEmail = 'intruso@example.com';
  const target = app();
  await request(target)
    .post('/api?__path=auth/verify-code')
    .send({ email, code: '123456' })
    .expect(403);
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/rest/'))).toBe(false);
  authenticatedEmail = email;
});
