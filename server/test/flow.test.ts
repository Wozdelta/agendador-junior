// Fluxos completos no MODO DEMONSTRAÇÃO (sem credenciais, sem rede), usando o
// relógio real para as datas e avançando um relógio de teste para a fila.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { draftWithVideos, fixtures, futureBr, idemKey, makeEnv, pastBr, TestClock } from './helpers.js';

const fx = fixtures();

describe('criação do lote', () => {
  it('um vídeo: data inicial às 12:00 em São Paulo, guardada em UTC', async () => {
    const env = await makeEnv();
    const start = futureBr(10);
    const { id } = await draftWithVideos(env, start, 1);
    const b = (await env.api.get(`/api/batches/${id}`).expect(200)).body;
    expect(b.status).toBe('draft');
    expect(b.items).toHaveLength(1);
    expect(b.items[0].scheduledLocal).toBe(`${start} 12:00`);
    expect(b.items[0].scheduledAt).toMatch(/T15:00:00\.000Z$/);
    expect(b.items[0].media).toMatchObject({ width: 360, height: 640 });
    expect(b.items[0].media.durationSec).toBeGreaterThan(3);
    // O nome interno do arquivo nunca é exposto ao frontend
    expect(JSON.stringify(b)).not.toMatch(/internalName/);
  });

  it('cinco vídeos em dias consecutivos ao meio-dia, incluindo fim de semana', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(20), 5);
    const b = (await env.api.get(`/api/batches/${id}`).expect(200)).body;
    const times = b.items.map((i: any) => new Date(i.scheduledAt).getTime());
    for (let i = 1; i < 5; i++) expect(times[i] - times[i - 1]).toBe(86_400_000);
    expect(b.items.every((i: any) => i.scheduledLocal.endsWith(' 12:00'))).toBe(true);
    expect(b.items.map((i: any) => i.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reordenação (Subir/Descer/arrastar) e exclusão recalculam datas e mantêm textos e capa no vídeo certo', async () => {
    const env = await makeEnv();
    const { id, itemIds } = await draftWithVideos(env, futureBr(15), 3);
    await env.api.put(`/api/batches/${id}/items/${itemIds[2]}/cover`).attach('file', fx.cover).expect(200);
    const before = (await env.api.get(`/api/batches/${id}`)).body;
    const dates = before.items.map((i: any) => i.scheduledLocal);

    // "Subir" o terceiro duas vezes = nova ordem [3,1,2]
    const after = (await env.api.put(`/api/batches/${id}/order`).send({ itemIds: [itemIds[2], itemIds[0], itemIds[1]] }).expect(200)).body;
    expect(after.items.map((i: any) => i.id)).toEqual([itemIds[2], itemIds[0], itemIds[1]]);
    expect(after.items.map((i: any) => i.scheduledLocal)).toEqual(dates); // datas seguem a posição
    expect(after.items[0].platforms.facebook.description).toBe('FB descrição 3'); // textos seguem o vídeo
    expect(after.items[0].cover).toBeTruthy(); // capa segue o vídeo
    expect(after.items[1].cover).toBeUndefined();

    // Excluir o primeiro: os outros sobem um dia
    const del = (await env.api.delete(`/api/batches/${id}/items/${itemIds[2]}`).expect(200)).body;
    expect(del.items.map((i: any) => i.scheduledLocal)).toEqual(dates.slice(0, 2));
    expect(del.items[0].platforms.youtube.title).toBe('YT título 1');

    // Mudar a data inicial recalcula tudo e preserva textos
    const moved = (await env.api.patch(`/api/batches/${id}`).send({ startDate: futureBr(30) }).expect(200)).body;
    expect(moved.items[0].scheduledLocal).toBe(`${futureBr(30)} 12:00`);
    expect(moved.items[1].platforms.instagram.description).toBe('IG legenda 2 #teste');
  });

  it('textos por plataforma são independentes', async () => {
    const env = await makeEnv();
    const { id, itemIds } = await draftWithVideos(env, futureBr(5), 1);
    const b = (await env.api.patch(`/api/batches/${id}/items/${itemIds[0]}`).send({ platforms: { facebook: { description: 'só no Facebook' } } }).expect(200)).body;
    const p = b.items[0].platforms;
    expect(p.facebook.description).toBe('só no Facebook');
    expect(p.instagram.description).toBe('IG legenda 1 #teste');
    expect(p.tiktok.description).toBe('TT descrição 1');
    expect(p.youtube.description).toBe('YT descrição 1');
  });

  it('datas passadas, de hoje já vencidas e inválidas geram erro de formulário', async () => {
    const env = await makeEnv();
    const past = await env.api.post('/api/batches').send({ startDate: pastBr(1) }).expect(400);
    expect(past.body.error).toMatch(/já passou/);
    expect(past.body.details.field).toBe('startDate');
    await env.api.post('/api/batches').send({ startDate: '31/02/2027' }).expect(400);
    await env.api.post('/api/batches').send({ startDate: '2027-01-10' }).expect(400);

    // Rascunho que "envelheceu": o servidor recusa a confirmação
    const { id } = await draftWithVideos(env, futureBr(3), 2);
    env.clock.advance(5 * 86_400_000);
    const s = (await env.api.get(`/api/batches/${id}/summary`).expect(200)).body;
    expect(s.canConfirm).toBe(false);
    const c = await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(422);
    expect(c.body.details.some((d: any) => d.field === 'startDate')).toBe(true);
    expect(env.ctx.modes.demo.tasks.all()).toHaveLength(0);
  });

  it('valida mídia no servidor: tipo real, Shorts vertical e campos obrigatórios', async () => {
    const env = await makeEnv();
    const created = (await env.api.post('/api/batches').send({ startDate: futureBr(4) }).expect(201)).body;
    const r = (await env.api.post(`/api/batches/${created.id}/items`).send({ files: [{ name: 'a.mp4' }, { name: 'b.mp4' }] }).expect(201)).body;
    const bad = await env.api.put(`/api/batches/${created.id}/items/${r.itemIds[0]}/video`).attach('file', fx.notVideo).expect(415);
    expect(bad.body.error).toMatch(/Formato não suportado/);
    await env.api.put(`/api/batches/${created.id}/items/${r.itemIds[1]}/video`).attach('file', fx.horizontal).expect(200);
    const s = (await env.api.get(`/api/batches/${created.id}/summary`)).body;
    expect(s.canConfirm).toBe(false);
    expect(s.issues.some((i: any) => /verticais ou quadrados/.test(i.message))).toBe(true);
    expect(s.issues.some((i: any) => /feito para crianças/.test(i.message))).toBe(true);
    expect(s.issues.some((i: any) => /envio do arquivo ainda não terminou/.test(i.message))).toBe(true);
    // nenhum arquivo temporário ou inválido sobra no disco
    const files = fs.readdirSync(env.ctx.modes.demo.mediaDir);
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(files).toHaveLength(1);
  });
});

describe('persistência, fila e agenda', () => {
  it('fechar a aba: o rascunho com textos sobrevive (fica no servidor)', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(6), 2);
    // "nova aba": outro processo lendo o mesmo diretório de dados
    const env2 = await makeEnv({ dir: env.dir });
    const drafts = (await env2.api.get('/api/batches?status=draft').expect(200)).body;
    expect(drafts.map((d: any) => d.id)).toContain(id);
    const b = drafts.find((d: any) => d.id === id);
    expect(b.items[1].platforms.tiktok.description).toBe('TT descrição 2');
  });

  it('resumo e confirmação: uma tarefa por vídeo + plataforma + conta, e a fila agenda sem a aba aberta', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(7), 2);
    const s = (await env.api.get(`/api/batches/${id}/summary`).expect(200)).body;
    expect(s.canConfirm).toBe(true);
    expect(s.rows[0].platforms.map((p: any) => p.platform).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'youtube']);

    const c = (await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201)).body;
    expect(c.tasks).toHaveLength(8);
    expect(new Set(c.tasks.map((t: any) => `${t.itemId}|${t.platform}|${t.accountId}`)).size).toBe(8);

    await env.worker.drain();
    const tasks = (await env.api.get('/api/tasks')).body.tasks;
    const by = (p: string) => tasks.filter((t: any) => t.platform === p);
    expect(by('youtube').every((t: any) => t.state === 'scheduled_remote' && t.nativeSchedule && t.remoteId)).toBe(true);
    expect(by('facebook').every((t: any) => t.state === 'scheduled_remote')).toBe(true);
    expect(by('instagram').every((t: any) => t.state === 'queued')).toBe(true); // container só perto do horário
    expect(by('tiktok').every((t: any) => t.state === 'manual_action' && t.manualReason === 'tiktok_manual')).toBe(true);

    // Chega o meio-dia do primeiro vídeo
    const first = tasks.find((t: any) => t.platform === 'instagram');
    env.clock.set(new Date(new Date(first.plannedAt).getTime() - 60 * 60_000).toISOString());
    await env.worker.drain();
    env.clock.set(first.plannedAt);
    await env.worker.drain();
    const t2 = (await env.api.get('/api/tasks')).body.tasks.filter((t: any) => t.plannedAt === first.plannedAt);
    for (const t of t2.filter((x: any) => x.platform !== 'tiktok')) {
      expect(t.state).toBe('published');
      expect(t.effectiveAt).toBeTruthy();
      expect(t.plannedLocal).toMatch(/12:00$/);
    }
  });

  it('clique duplo: mesma chave repete a resposta; chaves diferentes não duplicam tarefas', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(8), 2);
    const key = idemKey();
    const [a, b, c] = await Promise.all([
      env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', key),
      env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', key),
      env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()),
    ]);
    const statuses = [a.status, b.status, c.status];
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true);
    expect(env.ctx.modes.demo.tasks.all()).toHaveLength(8);
    const replay = await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(env.ctx.modes.demo.tasks.all()).toHaveLength(8);
  });

  it('reinício do backend durante um envio: reconcilia pelo ID remoto sem duplicar', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(9), 1);
    await env.api.patch(`/api/batches/${id}`).send({ platforms: { facebook: false, instagram: false, tiktok: false } }).expect(200);
    await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201);
    // A plataforma recebe o vídeo, mas a resposta se perde (timeout)…
    await env.api.post('/api/demo/faults').send({ platform: 'youtube', kind: 'timeout' }).expect(200);
    await env.worker.drain();
    let t = env.ctx.modes.demo.tasks.all()[0];
    expect(t.remote.needsReconcile).toBe(true);
    expect(t.state).toBe('processing');
    // …e o processo cai com a tarefa travada.
    await env.ctx.modes.demo.tasks.update(t.id, (x) => {
      x.lock = { bootId: 'processo-antigo', at: new Date().toISOString() };
    });
    const env2 = await makeEnv({ dir: env.dir, clock: env.clock }); // reinício
    await env2.worker.drain();
    t = env2.ctx.modes.demo.tasks.all()[0];
    expect(t.state).toBe('scheduled_remote');
    const remotes = Object.values(env2.ctx.modes.demo.demo.get().remote).filter((r) => r.taskId === t.id);
    expect(remotes).toHaveLength(1); // nenhum envio duplicado
    expect(t.history.some((h) => /reiniciou/.test(h.message))).toBe(true);
    expect(t.history.some((h) => /Nada será reenviado/.test(h.message))).toBe(true);
  });

  it('resultado desconhecido que não dá para verificar vira revisão manual', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(9), 1);
    await env.api.patch(`/api/batches/${id}`).send({ platforms: { youtube: false, instagram: false, tiktok: false } }).expect(200);
    await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201);
    await env.api.post('/api/demo/faults').send({ platform: 'facebook', kind: 'unverifiable' }).expect(200);
    await env.worker.drain();
    env.clock.advance(60 * 60_000);
    await env.worker.drain();
    const t = (await env.api.get('/api/tasks')).body.tasks[0];
    expect(t.state).toBe('manual_action');
    expect(t.manualReason).toBe('review_unknown');
    expect(t.actions).toContain('resolve_review');
    const fixed = (await env.api.post(`/api/tasks/${t.id}/resolve-review`).set('Idempotency-Key', idemKey()).send({ outcome: 'not_published' }).expect(200)).body;
    expect(fixed.state).toBe('queued');
    await env.worker.drain();
    expect((await env.api.get('/api/tasks')).body.tasks[0].state).toBe('scheduled_remote');
  });

  it('falha em uma plataforma com sucesso nas demais; nova tentativa só daquele Reel', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(2), 1);
    await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201);
    await env.api.post('/api/demo/faults').send({ platform: 'instagram', kind: 'fail' }).expect(200);
    await env.worker.drain();
    const planned = env.ctx.modes.demo.tasks.all()[0].plannedAt;
    env.clock.set(new Date(new Date(planned).getTime() - 60 * 60_000).toISOString()); // hora do container
    await env.worker.drain();
    let tasks = (await env.api.get('/api/tasks')).body.tasks;
    const ig = tasks.find((t: any) => t.platform === 'instagram');
    expect(ig.state).toBe('failed');
    expect(ig.lastError).toMatch(/recusou/);
    expect(ig.actions).toContain('retry');
    expect(tasks.find((t: any) => t.platform === 'youtube').state).toBe('scheduled_remote');
    expect(tasks.find((t: any) => t.platform === 'facebook').state).toBe('scheduled_remote');

    const ytBefore = tasks.find((t: any) => t.platform === 'youtube');
    await env.api.post(`/api/tasks/${ig.id}/retry`).set('Idempotency-Key', idemKey()).expect(200);
    await env.worker.drain();
    tasks = (await env.api.get('/api/tasks')).body.tasks;
    expect(tasks.find((t: any) => t.platform === 'instagram').state).toBe('processing');
    const ytAfter = tasks.find((t: any) => t.platform === 'youtube');
    expect(ytAfter.remoteId).toBe(ytBefore.remoteId); // YouTube intocado
    expect(ytAfter.history).toEqual(ytBefore.history);
    env.clock.set(planned);
    await env.worker.drain();
    expect((await env.api.get('/api/tasks')).body.tasks.find((t: any) => t.platform === 'instagram').state).toBe('published');
  });

  it('TikTok manual: copiar descrição, baixar o vídeo e registrar a conclusão com link', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(3), 1);
    await env.api.patch(`/api/batches/${id}`).send({ platforms: { facebook: false, youtube: false, instagram: false } }).expect(200);
    await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201);
    const t = (await env.api.get('/api/tasks')).body.tasks[0];
    expect(t.state).toBe('manual_action');
    expect(t.description).toBe('TT descrição 1');
    expect(t.actions).toEqual(expect.arrayContaining(['manual_complete', 'cancel']));
    const dl = await env.api.get(`/api/media/${t.mediaId}?download=1`).expect(200);
    expect(dl.headers['content-disposition']).toMatch(/vertical\.mp4/); // nome original do arquivo enviado
    expect(dl.headers['content-type']).toBe('video/mp4');
    await env.api.post(`/api/tasks/${t.id}/manual-complete`).set('Idempotency-Key', idemKey()).send({ url: 'javascript:alert(1)' }).expect(400);
    const done = (await env.api
      .post(`/api/tasks/${t.id}/manual-complete`)
      .set('Idempotency-Key', idemKey())
      .send({ url: 'https://www.tiktok.com/@eu/video/123' })
      .expect(200)).body;
    expect(done.state).toBe('published');
    expect(done.publishedManually).toBe(true);
    expect(done.remoteUrl).toBe('https://www.tiktok.com/@eu/video/123');
  });

  it('atraso além da tolerância vira "Atrasado" e permite escolher nova data', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(2), 1);
    await env.api.patch(`/api/batches/${id}`).send({ platforms: { facebook: false, youtube: false, tiktok: false } }).expect(200);
    await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201);
    const t0 = env.ctx.modes.demo.tasks.all()[0];
    // Backend desligado do horário até depois da tolerância
    env.clock.set(new Date(new Date(t0.plannedAt).getTime() + 30 * 60_000).toISOString());
    await env.worker.tick();
    let t = (await env.api.get('/api/tasks')).body.tasks[0];
    expect(t.state).toBe('late');
    expect(t.actions).toContain('reschedule');
    await env.api.post(`/api/tasks/${t.id}/reschedule`).set('Idempotency-Key', idemKey()).send({ date: pastBr(1) }).expect(400);
    const newDate = futureBr(12);
    t = (await env.api.post(`/api/tasks/${t.id}/reschedule`).set('Idempotency-Key', idemKey()).send({ date: newDate }).expect(200)).body;
    expect(t.state).toBe('queued');
    expect(t.plannedLocal).toBe(`${newDate} 12:00`);
  });

  it('cancelar um agendamento nativo confirma com a plataforma antes de mostrar "Cancelado"', async () => {
    const env = await makeEnv();
    const { id } = await draftWithVideos(env, futureBr(4), 1);
    await env.api.patch(`/api/batches/${id}`).send({ platforms: { facebook: false, instagram: false, tiktok: false } }).expect(200);
    await env.api.post(`/api/batches/${id}/confirm`).set('Idempotency-Key', idemKey()).expect(201);
    await env.worker.drain();
    const t = (await env.api.get('/api/tasks')).body.tasks[0];
    expect(t.state).toBe('scheduled_remote');
    const c = (await env.api.post(`/api/tasks/${t.id}/cancel`).set('Idempotency-Key', idemKey()).expect(200)).body;
    expect(c.state).toBe('cancelled');
    expect(env.ctx.modes.demo.demo.get().remote[t.remoteId].status).toBe('cancelled');
  });

  it('modo demonstração isolado do real e troca só com confirmação explícita', async () => {
    const env = await makeEnv();
    await draftWithVideos(env, futureBr(5), 1);
    await env.api.post('/api/settings/mode').send({ mode: 'real' }).expect(400);
    await env.api.post('/api/settings/mode').send({ mode: 'real', confirm: true }).expect(200);
    expect((await env.api.get('/api/batches').expect(200)).body).toHaveLength(0);
    const conns = (await env.api.get('/api/connections')).body;
    expect(conns.every((c: any) => !String(c.accountName ?? '').includes('[DEMO]'))).toBe(true);
    await env.api.post('/api/demo/faults').send({ platform: 'youtube', kind: 'fail' }).expect(409);
    // No modo real, sem conexões, o lote não confirma (exceto TikTok manual)
    const { id } = await draftWithVideos(env, futureBr(5), 1);
    const s = (await env.api.get(`/api/batches/${id}/summary`)).body;
    expect(s.canConfirm).toBe(false);
    expect(s.issues.some((i: any) => /Conecte o YouTube/.test(i.message))).toBe(true);
    await env.api.patch(`/api/batches/${id}`).send({ platforms: { facebook: false, youtube: false, instagram: false } }).expect(200);
    expect((await env.api.get(`/api/batches/${id}/summary`)).body.canConfirm).toBe(true);
  });

  it('respostas sensíveis usam Cache-Control: no-store e escrita de outra origem é bloqueada', async () => {
    const env = await makeEnv();
    const r = await env.api.get('/api/connections').expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    await env.api.post('/api/batches').set('Origin', 'https://site-malicioso.example').send({ startDate: futureBr(3) }).expect(403);
    // Pedido externo (via túnel) só alcança mídia temporária e callbacks OAuth
    await env.api.get('/api/tasks').set('X-Forwarded-For', '203.0.113.9').expect(403);
  });
});

describe('relógio de teste', () => {
  it('é usado apenas para avançar a fila; as datas dos testes vêm do relógio real', () => {
    const c = new TestClock();
    const real = Date.now();
    expect(Math.abs(c.now().getTime() - real)).toBeLessThan(1000);
  });
});
