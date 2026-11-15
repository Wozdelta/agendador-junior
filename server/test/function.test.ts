import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/index.js';
import * as configModule from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('a Function retorna 503 JSON quando integrações de produção estão ausentes', async () => {
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', ''); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('KV_REST_API_URL', ''); vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
  const app = express(); app.use(handler);
  const response = await request(app).get('/api?__path=connections').expect(503).expect('Content-Type', /json/);
  expect(response.body.code).toBe('service_not_configured');
});

it('o handler real atende Conexões e Agenda com configuração persistente simulada', async () => {
  const config = configModule.loadConfig({
    runtime: 'vercel', storage: 'redis', mediaStorage: 'blob',
    tokenKey: Buffer.alloc(32, 9).toString('base64'), cronSecret: 'fake-cron-secret',
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
