import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/index.js';
import * as config from '../src/config.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('a Function bloqueia toda API privada sem sessão, sem consultar banco ou provedor', async () => {
  vi.spyOn(config, 'loadConfig').mockReturnValue(
    config.loadConfig({ runtime: 'vercel', storage: 'file' }),
  );
  const fetch = vi.fn().mockRejectedValue(new Error('não deve chamar'));
  vi.stubGlobal('fetch', fetch);
  const app = express();
  app.use(handler);
  for (const route of [
    'settings',
    'tasks',
    'connections',
    'batches',
    'manual',
    'media/x',
    'oauth/tiktok/callback',
    'health',
  ]) {
    const r = await request(app)
      .get(`/api?__path=${route}`)
      .expect(401)
      .expect('Content-Type', /json/);
    expect(r.body.code).toBe('unauthenticated');
  }
  await request(app).post('/api?__path=manual').send({ ops: [] }).expect(401);
  await request(app).post('/api?__path=migration/legacy').send({}).expect(401);
  await request(app).get('/api?__path=auth/session').expect(200, { user: null });
  expect(fetch).not.toHaveBeenCalled();
});
