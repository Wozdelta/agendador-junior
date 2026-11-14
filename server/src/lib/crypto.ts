import crypto from 'node:crypto';

/**
 * Cofre de tokens: AES-256-GCM com IV aleatório de 12 bytes e AAD por plataforma.
 * A chave vem de TOKEN_ENCRYPTION_KEY (32 bytes em base64), fora do repositório.
 */
export class TokenVault {
  private key: Buffer | null;
  constructor(keyB64: string) {
    if (!keyB64) {
      this.key = null;
      return;
    }
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY precisa ter 32 bytes em base64.');
    this.key = key;
  }
  get available(): boolean {
    return this.key !== null;
  }
  encrypt(value: unknown, aad: string): string {
    if (!this.key) throw new Error('Defina TOKEN_ENCRYPTION_KEY no .env antes de conectar contas.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  }
  decrypt<T>(payload: string, aad: string): T {
    if (!this.key) throw new Error('TOKEN_ENCRYPTION_KEY ausente: não é possível ler os tokens salvos.');
    const [v, ivB, tagB, ctB] = payload.split(':');
    if (v !== 'v1') throw new Error('Formato de token criptografado desconhecido.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }
}

/** Links temporários assinados (HMAC) para a Meta baixar um arquivo específico. */
export function signMediaToken(secret: Buffer, mediaId: string, expiresAt: number): string {
  const payload = `${mediaId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}
export function verifyMediaToken(secret: Buffer, token: string, now: number): string | null {
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const payload = Buffer.from(p, 'base64url').toString();
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const cut = payload.lastIndexOf('.');
  const mediaId = payload.slice(0, cut);
  const exp = payload.slice(cut + 1);
  if (cut <= 0 || !(Number(exp) > now)) return null;
  return mediaId;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
