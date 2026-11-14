import type { AppContext, ModeContext } from '../context.js';
import type { ConnectionsDoc, StoredConnection } from '../domain/model.js';
import { AuthError } from '../lib/errors.js';

export type ConnKey = keyof ConnectionsDoc;

export function getConn(mc: ModeContext, key: ConnKey): StoredConnection | undefined {
  return mc.connections.get()[key];
}

export function readTokens<T>(ctx: AppContext, mc: ModeContext, key: ConnKey): T {
  const c = getConn(mc, key);
  if (!c?.tokensEnc) throw new AuthError(`Conta ${key} não conectada. Abra "Conexões" e conecte a conta.`);
  if (c.needsReconnect) throw new AuthError(`A autorização da conta ${key} expirou. Reconecte em "Conexões".`);
  return ctx.vault.decrypt<T>(c.tokensEnc, key);
}

export async function writeTokens(ctx: AppContext, mc: ModeContext, key: ConnKey, tokens: unknown): Promise<void> {
  const enc = ctx.vault.encrypt(tokens, key);
  await mc.connections.mutate((d) => {
    d[key] = { ...(d[key] ?? {}), tokensEnc: enc, needsReconnect: false };
  });
}

export async function markNeedsReconnect(mc: ModeContext, key: ConnKey): Promise<void> {
  await mc.connections.mutate((d) => {
    if (d[key]) d[key]!.needsReconnect = true;
  });
}
