import { AuthError, PermanentError, RetryableError, UnknownOutcomeError } from './errors.js';

export type FetchLike = typeof fetch;

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  /** true quando o pedido pode criar algo remotamente (upload, publicação). */
  mayCreate?: boolean;
  fetchImpl?: FetchLike;
  /** Necessário em Node quando o corpo é um stream. */
  duplex?: 'half';
}

/** Interpreta Retry-After em segundos ou data HTTP. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return undefined;
}

export async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await f(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body ?? undefined,
      signal: ctrl.signal,
      ...(opts.duplex ? { duplex: opts.duplex } : {}),
    } as RequestInit);
  } catch (err: any) {
    clearTimeout(timer);
    const what = err?.name === 'AbortError' ? 'tempo esgotado' : `falha de rede (${err?.message ?? err})`;
    if (opts.mayCreate) throw new UnknownOutcomeError(`Sem resposta do servidor (${what}); o resultado remoto é incerto.`);
    throw new RetryableError(`Sem resposta do servidor (${what}).`);
  }
  let text = '';
  try {
    text = await res.text();
  } catch (err: any) {
    clearTimeout(timer);
    if (opts.mayCreate) throw new UnknownOutcomeError('A conexão caiu durante a resposta; o resultado remoto é incerto.');
    throw new RetryableError('A conexão caiu durante a resposta.');
  }
  clearTimeout(timer);
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Classificação genérica de status HTTP (cada conector refina com os códigos da plataforma). */
export function throwForStatus(res: HttpResponse, message: string): never {
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  if (res.status === 401) throw new AuthError(`${message}: autorização expirada ou revogada. Reconecte a conta.`);
  if (res.status === 429) throw new RetryableError(`${message}: limite de requisições atingido.`, retryAfter, 'rate_limit');
  if (res.status >= 500) throw new RetryableError(`${message}: erro temporário do servidor (${res.status}).`, retryAfter);
  throw new PermanentError(`${message} (HTTP ${res.status}).`);
}

export function form(params: Record<string, string | number | boolean | undefined | null>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p;
}
