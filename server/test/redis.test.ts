import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { RedisRest } from '../src/lib/redis.js';
import { JsonCollection, RedisBackend } from '../src/lib/store.js';
import { createContext } from '../src/context.js';
import { Worker } from '../src/queue/worker.js';
import { draftWithVideos, futureBr, makeEnv } from './helpers.js';

// Execute the production Lua script (not a JS copy of its CAS logic).
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)('fengari');
export class MemoryRedis {
  values = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  cmd = (args: string[]): any => {
    const [op, key, ...rest] = args;
    switch (op.toUpperCase()) {
      case 'GET': return this.values.get(key) ?? null;
      case 'SET': this.values.set(key, rest[0]); return 'OK';
      case 'DEL': for (const k of [key, ...rest]) { this.values.delete(k); this.sets.delete(k); } return 1;
      case 'INCR': { const n = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(n)); return n; }
      case 'SADD': { const set = this.sets.get(key) ?? new Set<string>(); rest.forEach(x => set.add(x)); this.sets.set(key, set); return 1; }
      case 'SREM': rest.forEach(x => this.sets.get(key)?.delete(x)); return 1;
      case 'SMEMBERS': return [...(this.sets.get(key) ?? [])];
      case 'MGET': return [key, ...rest].map(k => this.values.get(k) ?? null);
      case 'EVAL': {
        const count = Number(rest[0]);
        const keys = rest.slice(1, count + 1), argv = rest.slice(count + 1);
        const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
        const table = (name: string, list: string[]) => {
          lua.lua_newtable(L);
          list.forEach((v, i) => { lua.lua_pushstring(L, to_luastring(v)); lua.lua_rawseti(L, -2, i + 1); });
          lua.lua_setglobal(L, to_luastring(name));
        };
        table('KEYS', keys); table('ARGV', argv);
        lua.lua_newtable(L);
        lua.lua_pushjsfunction(L, (state: any) => {
          const command = Array.from({ length: lua.lua_gettop(state) }, (_, i) => to_jsstring(lua.lua_tolstring(state, i + 1)));
          const result = this.cmd(command);
          if (result === null) lua.lua_pushboolean(state, false);
          else if (typeof result === 'number') lua.lua_pushnumber(state, result);
          else lua.lua_pushstring(state, to_luastring(result));
          return 1;
        });
        lua.lua_setfield(L, -2, to_luastring('call')); lua.lua_setglobal(L, to_luastring('redis'));
        const status = lauxlib.luaL_dostring(L, to_luastring(key));
        if (status !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tolstring(L, -1)));
        const result = lua.lua_tonumber(L, -1); lua.lua_close(L); return result;
      }
      default: throw new Error(`Unsupported test Redis command: ${op}`);
    }
  };
  fetch: typeof fetch = async (url, init) => {
    const args = JSON.parse(String(init?.body));
    return Response.json(String(url).endsWith('/pipeline') ? args.map((a: string[]) => ({ result: this.cmd(a) })) : { result: this.cmd(args) });
  };
}

describe('Redis concorrente e recuperação durável', () => {
  it('CAS Lua preserva atualizações concorrentes e permite remover/recriar', async () => {
    const memory = new MemoryRedis();
    const redis = new RedisRest('https://redis.test', 'fake', memory.fetch);
    const make = () => new JsonCollection<{ id: string; n: number }>(new RedisBackend(redis, 'test')).load();
    const a = await make(), b = await make();
    await a.mutate(d => { d.push({ id: 'one', n: 0 }); });
    await Promise.all([a.update('one', x => { x.n++; }), b.update('one', x => { x.n++; })]);
    await a.refresh(); expect(a.get('one')?.n).toBe(2);
    await b.mutate(d => { d.splice(0); });
    await a.mutate(d => { d.push({ id: 'one', n: 3 }); });
    await b.refresh(); expect(b.get('one')?.n).toBe(3);
  });
  it('duas instâncias processam a mesma fila sem duplicar; lease ativa não é recuperada', async () => {
    const memory = new MemoryRedis();
    const e = await makeEnv({ fetchImpl: memory.fetch, config: {
      storage: 'redis', redis: { url: 'https://redis.test', token: 'fake', prefix: 'queue-test' },
    } });
    const { id } = await draftWithVideos(e, futureBr(12), 1);
    await e.api.post(`/api/batches/${id}/confirm`).expect(201);
    const c2 = await createContext({ config: e.ctx.config, fetchImpl: memory.fetch, clock: e.clock });
    const w2 = new Worker(c2);
    const t = e.ctx.current().tasks.all().find(t => t.platform === 'youtube')!;
    await e.ctx.current().tasks.update(t.id, x => { x.lock = { bootId: 'other', at: e.clock.now().toISOString(), until: new Date(e.clock.now().getTime() + 360000).toISOString() }; });
    expect(await w2.recover()).toBe(0);
    e.clock.advance(361000);
    expect(await w2.recover()).toBe(1);
    await Promise.all([e.worker.drain(), w2.drain()]);
    await e.ctx.refresh(['demo']);
    const remote = Object.values(e.ctx.current().demo.get().remote);
    expect(remote.filter((r: any) => r.platform === 'youtube')).toHaveLength(1);
    expect(e.ctx.current().tasks.all()).toHaveLength(4);
  });
});
