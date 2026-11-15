// Cliente mínimo da API REST do Upstash Redis (sem conexões persistentes,
// adequado a Vercel Functions). Docs: https://upstash.com/docs/redis/features/restapi
import type { FetchLike } from './http.js';

export class RedisRest {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  async cmd<T = any>(...args: (string | number)[]): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const json: any = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || json.error) throw new Error(`Redis: ${json.error ?? `HTTP ${res.status}`}`);
    return json.result as T;
  }

  /** Vários comandos numa só requisição (não atômico). */
  async pipeline(cmds: (string | number)[][]): Promise<any[]> {
    if (cmds.length === 0) return [];
    const res = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(json)) throw new Error(`Redis pipeline: HTTP ${res.status}`);
    return json.map((r: any) => {
      if (r.error) throw new Error(`Redis: ${r.error}`);
      return r.result;
    });
  }
}

/**
 * Gravação atômica com verificação de versão por registro (compare-and-set).
 * KEYS: [rev, ids, rec1, ver1, rec2, ver2, ...]
 * ARGV: [n, tipo1, id1, versaoEsperada1, valor1, ...]  (tipo = put | del)
 * Retorna a nova revisão da coleção, ou -1 se algum registro mudou (conflito).
 */
export const COMMIT_SCRIPT = `
local n = tonumber(ARGV[1])
if tostring(redis.call('GET', KEYS[1]) or '0') ~= ARGV[2 + n * 4] then return -1 end
for i = 1, n do
  local base = 1 + (i - 1) * 4
  local cur = tonumber(redis.call('GET', KEYS[2 + i * 2])) or 0
  if cur ~= tonumber(ARGV[base + 3]) then return -1 end
end
for i = 1, n do
  local base = 1 + (i - 1) * 4
  local rk = KEYS[1 + i * 2]
  local vk = KEYS[2 + i * 2]
  if ARGV[base + 1] == 'put' then
    redis.call('SET', rk, ARGV[base + 4])
    redis.call('SET', vk, tonumber(ARGV[base + 3]) + 1)
    redis.call('SADD', KEYS[2], ARGV[base + 2])
  else
    redis.call('DEL', rk, vk)
    redis.call('SREM', KEYS[2], ARGV[base + 2])
  end
end
return redis.call('INCR', KEYS[1])
`;
