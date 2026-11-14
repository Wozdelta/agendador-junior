// Login para o acesso remoto (interface hospedada na Vercel).
// Senha: hash scrypt no ambiente (APP_PASSWORD_HASH). Sessão: cookie HttpOnly
// assinado com HMAC (chave derivada de TOKEN_ENCRYPTION_KEY por HKDF).
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'agj_sessao';

export function deriveKey(masterB64: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(masterB64, 'base64'), Buffer.alloc(0), info, 32));
}

/** Formato: scrypt$N$r$p$sal$hash (base64url). */
export function hashPassword(password: string): string {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, N, r, p, saltB, hashB] = stored.split('$');
  if (alg !== 'scrypt' || !saltB || !hashB) return false;
  const expected = Buffer.from(hashB, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(saltB, 'base64url'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, expected);
}

export function signSession(key: Buffer, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(key: Buffer, token: string | undefined, now: number): boolean {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > now;
  } catch {
    return false;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function safeEqual(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/** Limita tentativas de login por IP (memória do processo). */
export class LoginLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 10 * 60_000) {}
  blocked(ip: string, now: number): boolean {
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(ip, list);
    return list.length >= this.max;
  }
  fail(ip: string, now: number): void {
    this.hits.set(ip, [...(this.hits.get(ip) ?? []), now]);
  }
  reset(ip: string): void {
    this.hits.delete(ip);
  }
}
