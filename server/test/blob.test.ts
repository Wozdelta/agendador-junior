import fs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as storage from '../src/lib/supabase.js';
import { fixtures, futureBr, makeEnv } from './helpers.js';
import { remoteReader } from '../src/lib/mediaio.js';
afterEach(() => vi.restoreAllMocks());
describe('Supabase Storage privado', () => {
  it('finaliza cinco uploads diretos por Range sem ffprobe e sem expor bucket público', async () => {
    const bytes = fs.readFileSync(fixtures().vertical);
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method === 'HEAD')
        return new Response(null, { headers: { 'content-length': String(bytes.length) } });
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range')!)!;
      return new Response(bytes.subarray(Number(start), Number(end) + 1), { status: 206 });
    };
    vi.spyOn(storage, 'supabase').mockReturnValue({
      storage: {
        from: () => ({
          createSignedUploadUrl: async (path: string) => ({
            data: { signedUrl: `https://storage.test/${path}?token=test` },
            error: null,
          }),
        }),
      },
    } as any);
    vi.spyOn(storage, 'storageUrl').mockImplementation(
      async (_config, path) => `https://storage.test/${path}?token=read`,
    );
    const e = await makeEnv({ fetchImpl, config: { mediaStorage: 'supabase' } });
    const b = (
      await e.api
        .post('/api/batches')
        .send({ startDate: futureBr(8) })
        .expect(201)
    ).body;
    const reserved = (
      await e.api
        .post(`/api/batches/${b.id}/items`)
        .send({ files: Array.from({ length: 5 }, (_, i) => ({ name: `video${i}.mp4` })) })
        .expect(201)
    ).body;
    let final: any;
    for (const itemId of reserved.itemIds) {
      const prep = (
        await e.api
          .post('/api/storage/prepare')
          .send({ batchId: b.id, itemId, kind: 'video' })
          .expect(200)
      ).body;
      expect(prep.url).toContain(e.ctx.ownerId);
      final = (await e.api.post('/api/storage/complete').send({ ticket: prep.ticket }).expect(200))
        .body;
      await e.api.post('/api/storage/complete').send({ ticket: prep.ticket }).expect(200);
    }
    expect(
      final.items.every(
        (i: any) => i.uploadStatus === 'ready' && i.media.url.startsWith('/api/media/'),
      ),
    ).toBe(true);
    expect(final.items.every((i: any) => i.scheduledLocal.endsWith('12:00'))).toBe(true);
    expect(
      e.ctx
        .current()
        .media.all()
        .every((m) => m.storagePath && !m.blobUrl),
    ).toBe(true);
    expect(fs.readdirSync(e.ctx.current().mediaDir)).toHaveLength(0);
    await e.api
      .post('/api/storage/complete')
      .send({ ticket: 'forged', url: 'https://internal.example' })
      .expect(400);
  });
  it('recusa baixar o vídeo inteiro quando Range é ignorado', async () => {
    const e = await makeEnv({ fetchImpl: async () => new Response('full body') });
    await expect(remoteReader(e.ctx, 'https://storage.test/file')(0, 8)).rejects.toMatchObject({
      status: 422,
    });
  });
});
