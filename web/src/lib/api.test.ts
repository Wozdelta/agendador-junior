import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());
describe('respostas da API', () => {
  for (const [contentType, body] of [
    ['text/plain', 'A server error has occurred'],
    ['text/html', '<html>Service unavailable</html>'],
    ['application/json', '{invalid'],
  ]) it(`exibe indisponibilidade para ${contentType}`, async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(body, { status: 500, headers: { 'content-type': contentType } })));
    await expect(api.connections()).rejects.toMatchObject({ status: 500, code: 'invalid_response' });
    await expect(api.tasks()).rejects.toThrow(/Tente de novo/);
  });
  it('preserva status e erro JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Configure Redis', code: 'service_not_configured' }, { status: 503 })));
    await expect(api.connections()).rejects.toMatchObject({ status: 503, message: 'Configure Redis', code: 'service_not_configured' });
  });
  it('aceita JSON válido', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ tasks: [], drafts: [] })));
    await expect(api.tasks()).resolves.toEqual({ tasks: [], drafts: [] });
  });
  it('transforma falha de rede em ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(api.tasks()).rejects.toBeInstanceOf(ApiError);
  });
});
