import { createClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { CollectionBackend } from './store.js';
import { AppError } from './errors.js';
export function supabase(config: Config, secret = false, fetchImpl: typeof fetch = fetch) {
  const key = secret ? config.supabase.secretKey : config.supabase.publishableKey;
  if (!config.supabase.url || !key)
    throw new AppError(
      503,
      'Configure o Supabase na Vercel e tente de novo.',
      undefined,
      'supabase_not_configured',
    );
  return createClient(config.supabase.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
}
export class SupabaseBackend<T extends { id: string }> implements CollectionBackend<T> {
  constructor(
    private config: Config,
    private owner: () => string | undefined,
    private mode: string,
    private name: string,
    private fetchImpl: typeof fetch,
  ) {}
  private scope() {
    const id = this.owner();
    if (!id) throw new AppError(401, 'Entre para continuar.', undefined, 'unauthenticated');
    return id;
  }
  async load(rev: string | null) {
    const owner = this.scope();
    const { data, error } = await supabase(this.config, true, this.fetchImpl).rpc(
      'scheduler_load',
      { p_owner: owner, p_mode: this.mode, p_name: this.name },
    );
    if (error)
      throw new AppError(
        503,
        'Banco indisponível. Confira se setup.sql foi executado e tente de novo.',
        undefined,
        'database_unavailable',
      );
    const current = String(data.revision);
    return rev === current
      ? null
      : { items: data.items as T[], rev: current, versions: new Map<string, number>() };
  }
  async commit(_prev: T[], next: T[], _versions: Map<string, number>, rev?: string | null) {
    const owner = this.scope();
    const { data, error } = await supabase(this.config, true, this.fetchImpl).rpc(
      'scheduler_commit',
      {
        p_owner: owner,
        p_mode: this.mode,
        p_name: this.name,
        p_expected: Number(rev ?? 0),
        p_items: next,
      },
    );
    if (error)
      throw new AppError(
        503,
        'Não foi possível salvar no banco. Seus valores foram preservados; tente de novo.',
        undefined,
        'database_unavailable',
      );
    return data === null
      ? { ok: false as const }
      : { ok: true as const, rev: String(data), versions: new Map<string, number>() };
  }
}
export const MEDIA_BUCKET = 'agendador-media';
export async function storageUrl(config: Config, path: string, fetchImpl: typeof fetch = fetch, ttlSeconds = 600) {
  const { data, error } = await supabase(config, true, fetchImpl)
    .storage.from(MEDIA_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error) throw new AppError(503, 'Arquivo indisponível no Storage. Tente de novo.');
  return data.signedUrl;
}
