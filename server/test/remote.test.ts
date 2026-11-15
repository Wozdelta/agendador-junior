import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { makeEnv, draftWithVideos, futureBr } from './helpers.js';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config.js';

const APP = 'https://agendador-junior.vercel.app';
describe('API na Vercel sem proxy', () => {
  it('abre termos, privacidade e verificação TikTok diretamente', async () => {
    const e = await makeEnv();
    await e.api.get('/termos').expect(200).expect('Content-Type', /html/);
    await e.api.get('/privacidade').expect(200).expect('Content-Type', /html/);
    const name = 'tiktokx1Qmn4YclvyNgFAczoIKzXwE4yeNCzoz.txt';
    const response = await e.api.get(`/${name}`).expect(200).expect('Content-Type', /text\/plain/);
    expect(response.text).toBe(fs.readFileSync(path.join(PROJECT_ROOT, 'web/public', name), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'vercel.json'), 'utf8'));
    expect(config.rewrites.map((r: any) => r.source)).toEqual(['/api/:path*', '/termos', '/privacidade']);
  });
  it('Connections, Agenda, erro JSON, origem e cron autenticado', async () => {
    const e = await makeEnv({ config: { runtime: 'vercel', appUrl: APP, cronSecret: 'test-secret', tickBudgetMs: 50 } });
    await e.api.get('/api/connections').expect(200).expect('Content-Type', /json/);
    await e.api.get('/api/tasks').expect(200).expect('Content-Type', /json/);
    const missing = await e.api.get('/api/missing').expect(404);
    expect(missing.body.code).toBe('not_found');
    await e.api.post('/api/batches').set('Content-Type', 'application/json').send('{bad').expect(400).expect('Content-Type', /json/);
    await e.api.post('/api/batches').set('Origin', 'https://other.example').send({}).expect(403);
    await e.api.post('/api/cron/tick').expect(401);
    await e.api.post('/api/cron/tick').set('Authorization', 'Bearer test-secret').expect(200);
  });
  it('cinco videos com datas consecutivas ao meio-dia e status por plataforma', async () => {
    const e = await makeEnv();
    const { id } = await draftWithVideos(e, futureBr(15), 5);
    const result = await e.api.post(`/api/batches/${id}/confirm`).expect(201);
    expect(result.body.tasks).toHaveLength(20);
    expect(new Set(result.body.tasks.map((t: any) => t.plannedAt)).size).toBe(5);
    expect(result.body.batch.items.every((i: any) => i.scheduledLocal.endsWith('12:00'))).toBe(true);
    await e.api.post(`/api/batches/${id}/confirm`).expect(200);
    expect(e.ctx.current().tasks.all()).toHaveLength(20);
  });
  it('state TikTok sobrevive a outra instancia, expira e tem uso unico', async () => {
    const e = await makeEnv({ mode: 'real', config: {
      appUrl: APP, webOrigin: APP,
      tiktok: { clientKey: 'fake-test-key', clientSecret: 'fake-test-secret', redirectUri: `${APP}/api/oauth/tiktok/callback`, uploadApproved: false, directPostApproved: false, inboxLeadMinutes: 30 },
    } });
    const result = await e.api.get('/api/connections/tiktok/start').expect(302);
    const auth = new URL(result.headers.location);
    expect(auth.searchParams.get('redirect_uri')).toBe(`${APP}/api/oauth/tiktok/callback`);
    expect(auth.searchParams.get('scope')).not.toContain('video.upload');
    const state = auth.searchParams.get('state')!;
    const c2 = await createContext({ config: e.ctx.config });
    const second = request(createApp(c2));
    const cb = `/api/oauth/tiktok/callback?state=${encodeURIComponent(state)}&error=access_denied`;
    const back = await second.get(cb).expect(302);
    expect(back.headers.location).toContain('erro=access_denied');
    await second.get(cb).expect(400).expect('Content-Type', /json/);
    await second.get('/api/oauth/tiktok/callback?state=invalid&code=x').expect(400);
    const expired = c2.vault.encrypt({ nonce: 'expired', platform: 'tiktok', createdAt: Date.now() - 700000, returnTo: APP }, 'oauth-state');
    await second.get(`/api/oauth/tiktok/callback?state=${encodeURIComponent(expired)}`).expect(400);
  });
});
