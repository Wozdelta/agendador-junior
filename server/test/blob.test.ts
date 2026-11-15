import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { head } from '@vercel/blob';
import { fixtures, futureBr, makeEnv } from './helpers.js';
import { blobReader } from '../src/lib/mediaio.js';

vi.mock('@vercel/blob', () => ({ head: vi.fn(), del: vi.fn() }));
describe('mídia persistente no caminho de produção', () => {
  it('finaliza cinco uploads de teste lendo MP4 por Range, sem ffprobe, e mantém URLs Blob', async () => {
    const bytes = fs.readFileSync(fixtures().vertical);
    const fetchImpl: typeof fetch = async (_url, init) => {
      const range = new Headers(init?.headers).get('range')!;
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range)!;
      return new Response(bytes.subarray(Number(start), Number(end) + 1), { status: 206 });
    };
    const e = await makeEnv({ fetchImpl, config: { mediaStorage: 'blob', blobToken: 'fake-test-token' } });
    const b = (await e.api.post('/api/batches').send({ startDate: futureBr(8) }).expect(201)).body;
    const reserved = (await e.api.post(`/api/batches/${b.id}/items`).send({ files: Array.from({ length: 5 }, (_, i) => ({ name: `video${i}.mp4` })) }).expect(201)).body;
    let final: any;
    for (const itemId of reserved.itemIds) {
      const prep = (await e.api.post('/api/blob/prepare').send({ batchId: b.id, itemId, kind: 'video' }).expect(200)).body;
      const url = `https://test.public.blob.vercel-storage.com/${prep.pathname}`;
      vi.mocked(head).mockResolvedValue({ pathname: prep.pathname, size: bytes.length } as any);
      final = (await e.api.post('/api/blob/complete').send({ ticket: prep.ticket, url }).expect(200)).body;
      await e.api.post('/api/blob/complete').send({ ticket: prep.ticket, url }).expect(200);
    }
    expect(final.items.every((i: any) => i.uploadStatus === 'ready' && i.media.url.includes('.blob.vercel-storage.com/'))).toBe(true);
    expect(final.items.every((i: any) => i.scheduledLocal.endsWith('12:00'))).toBe(true);
    expect(final.items[0].media).toMatchObject({ width: 360, height: 640, videoCodec: 'h264' });
    expect(e.ctx.current().media.all()).toHaveLength(5);
    expect(fs.readdirSync(e.ctx.current().mediaDir)).toHaveLength(0);
    await e.api.put(`/api/batches/${b.id}/items/${reserved.itemIds[0]}/video`).send('test').expect(400);
    await e.api.post('/api/blob/complete').send({ ticket: 'forged', url: 'https://internal.example/x' }).expect(400);
  });
  it('não baixa um vídeo inteiro quando o armazenamento ignora Range', async () => {
    const e = await makeEnv({ fetchImpl: async () => new Response('full body', { status: 200 }) });
    await expect(blobReader(e.ctx, 'https://test.public.blob.vercel-storage.com/file')(0, 8)).rejects.toMatchObject({ status: 422 });
  });
});
