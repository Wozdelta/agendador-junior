// Utilitários de chave e comparação usados no acesso remoto (Vercel -> Node).
import crypto from 'node:crypto';

/** Deriva uma subchave de TOKEN_ENCRYPTION_KEY (HKDF-SHA256). */
export function deriveKey(masterB64: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(masterB64, 'base64'), Buffer.alloc(0), info, 32));
}

/** Compara segredos em tempo constante. */
export function safeEqual(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
