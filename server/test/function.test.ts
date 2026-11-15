import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/index.js';
import * as configModule from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('a Function abre Agenda, Conexões e Configurações sem integrações nem segredos', async () => {
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', ''); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('KV_REST_API_URL', ''); vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
  const mkdir = vi.spyOn(fsp, 'mkdir').mockRejectedValue(new Error('Sem disco persistente'));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Nenhuma chamada externa deve ocorrer')));
  const app = express(); app.use(handler);
  const response = await request(app).get('/api?__path=connections').expect(200).expect('Content-Type', /json/);
  expect(response.body).toHaveLength(4);
  expect(response.body.every((c: any) => c.canConnect === false)).toBe(true);
  await request(app).get('/api?__path=tasks').expect(200);
  const settings = await request(app).get('/api?__path=settings').expect(200);
  expect(settings.body).toMatchObject({ serverPersistence: false, mediaPersistence: false, oauthAvailable: false, backgroundWorker: false });
  const connect = await request(app).get('/api?__path=connections/youtube/start').expect(409);
  expect(connect.body.code).toBe('persistence_required');
  expect(fetch).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
});

it('uma chave inválida não bloqueia telas, e é recusada somente na ação OAuth', async () => {
  const config = configModule.loadConfig({ runtime: 'vercel', storage: 'redis', mediaStorage: 'disk', tokenKey: 'invalid',
    redis: { url: 'https://redis.test', token: 'fake', prefix: 'test' } });
  vi.spyOn(configModule, 'loadConfig').mockReturnValue(config);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ result: null })));
  const app = express(); app.use(handler);
  await request(app).get('/api?__path=settings').expect(200);
  await request(app).get('/api?__path=connections').expect(200);
  await request(app).get('/api?__path=tasks').expect(200);
  const oauth = await request(app).get('/api?__path=connections/youtube/start').expect(409);
  expect(oauth.body.code).toBe('encryption_required');
  const upload = await request(app).post('/api?__path=blob/prepare').send({}).expect(409);
  expect(upload.body.code).toBe('media_storage_required');
});

it('Redis indisponível não derruba Configurações, Conexões ou a agenda manual', async () => {
  const config = configModule.loadConfig({ runtime: 'vercel', storage: 'redis', mediaStorage: 'disk', tokenKey: '',
    redis: { url: 'https://redis.test', token: 'fake', prefix: 'test' } });
  vi.spyOn(configModule, 'loadConfig').mockReturnValue(config);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Redis offline')));
  const app = express(); app.use(handler);
  await request(app).get('/api?__path=settings').expect(200);
  expect(fetch).not.toHaveBeenCalled();
  const c = await request(app).get('/api?__path=connections').expect(200);
  expect(c.body.every((x: any) => x.canConnect === false && x.notes.some((n: string) => n.includes('indisponível')))).toBe(true);
  const t = await request(app).get('/api?__path=tasks').expect(200);
  expect(t.body.warning).toContain('não foram apagados');
  const write = await request(app).post('/api?__path=batches').send({}).expect(503);
  expect(write.body.code).toBe('storage_unavailable');
});

it('preserva conexões criptografadas existentes e permite OAuth sem Blob', async () => {
  const config = configModule.loadConfig({ runtime: 'vercel', storage: 'redis', mediaStorage: 'disk', tokenKey: Buffer.alloc(32, 1).toString('base64'),
    redis: { url: 'https://redis.test', token: 'fake', prefix: 'test' },
    google: { clientId: 'fake-id', clientSecret: 'fake-secret', redirectUri: 'https://agendador-junior.vercel.app/api/oauth/youtube/callback' } });
  vi.spyOn(configModule, 'loadConfig').mockReturnValue(config);
  const encrypted = 'v1:encrypted-token-preserved';
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, init) => {
    const cmd = JSON.parse(init.body);
    if (String(url).endsWith('/pipeline')) return Response.json(cmd.map((c: string[]) => ({ result: c.slice(1).map(k => k.includes(':r:doc') ? JSON.stringify({ id: 'doc', youtube: { tokensEnc: encrypted, accountName: 'Canal existente', accountId: 'channel' } }) : '1') })));
    const result = cmd[0] === 'GET' ? (cmd[1].endsWith(':connections:rev') ? '1' : null) : cmd[0] === 'SMEMBERS' && cmd[1].endsWith(':connections:ids') ? ['doc'] : [];
    return Response.json({ result });
  }));
  const app = express(); app.use(handler);
  const c = await request(app).get('/api?__path=connections').expect(200);
  expect(c.body.find((x: any) => x.platform === 'youtube')).toMatchObject({ connected: true, canConnect: true, accountName: 'Canal existente' });
  expect(JSON.stringify(c.body)).not.toContain(encrypted);
  await request(app).get('/api?__path=connections/youtube/start').expect(302);
});

it('o handler real atende Conexões e Agenda com configuração persistente simulada', async () => {
  const config = configModule.loadConfig({
    runtime: 'vercel', storage: 'redis', mediaStorage: 'blob',
    tokenKey: Buffer.alloc(32, 9).toString('base64'),
    redis: { url: 'https://redis.test', token: 'fake', prefix: 'function-test' },
    blobToken: 'fake-blob-token', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agj-function-')),
  });
  vi.spyOn(configModule, 'loadConfig').mockReturnValue(config);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ result: null })));
  const app = express(); app.use(handler);
  const connections = await request(app).get('/api?__path=connections').expect(200).expect('Content-Type', /json/);
  expect(connections.body).toHaveLength(4);
  const agenda = await request(app).get('/api?__path=tasks').expect(200);
  expect(agenda.body).toEqual({ tasks: [], drafts: [] });
});
