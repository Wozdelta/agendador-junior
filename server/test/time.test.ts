import { describe, expect, it } from 'vitest';
import { computeSchedule, formatLocal, parseBrDate } from '../src/lib/time.js';
import { parseRetryAfter } from '../src/lib/http.js';
import { signMediaToken, TokenVault, verifyMediaToken } from '../src/lib/crypto.js';
import { redact } from '../src/lib/log.js';

describe('datas', () => {
  it('aceita DD/MM/AAAA válidas e recusa datas inexistentes', () => {
    expect(parseBrDate('15/11/2026')).toBe('2026-11-15');
    expect(parseBrDate('29/02/2028')).toBe('2028-02-29');
    expect(parseBrDate('29/02/2027')).toBeNull();
    expect(parseBrDate('31/04/2027')).toBeNull();
    expect(parseBrDate('2026-11-15')).toBeNull();
    expect(parseBrDate('1/1/2027')).toBeNull();
  });

  it('cinco vídeos a partir de 15/11/2026: um por dia corrido às 12:00 em São Paulo', () => {
    const d = computeSchedule('2026-11-15', 5, 'America/Sao_Paulo', '12:00');
    expect(d.map((x) => formatLocal(x, 'America/Sao_Paulo'))).toEqual([
      '15/11/2026 12:00', // domingo
      '16/11/2026 12:00',
      '17/11/2026 12:00',
      '18/11/2026 12:00',
      '19/11/2026 12:00',
    ]);
    // Guardado em UTC (São Paulo = UTC-3, sem horário de verão)
    expect(d[0].toISOString()).toBe('2026-11-15T15:00:00.000Z');
    expect(d[4].toISOString()).toBe('2026-11-19T15:00:00.000Z');
  });

  it('atravessa virada de mês e ano somando dias de calendário', () => {
    const d = computeSchedule('2026-12-30', 4, 'America/Sao_Paulo', '12:00');
    expect(d.map((x) => formatLocal(x, 'America/Sao_Paulo'))).toEqual([
      '30/12/2026 12:00',
      '31/12/2026 12:00',
      '01/01/2027 12:00',
      '02/01/2027 12:00',
    ]);
  });
});

describe('utilitários de segurança e rede', () => {
  it('Retry-After em segundos e em data HTTP', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(parseRetryAfter('Sat, 14 Nov 2026 12:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('AES-256-GCM: cifra, decifra e rejeita adulteração ou AAD errado', () => {
    const v = new TokenVault(Buffer.alloc(32, 1).toString('base64'));
    const secretValue = 'valor-secreto-123';
    const enc = v.encrypt({ rt: secretValue }, 'youtube');
    expect(enc).not.toContain(secretValue);
    expect(v.decrypt<{ rt: string }>(enc, 'youtube').rt).toBe(secretValue);
    expect(() => v.decrypt(enc, 'tiktok')).toThrow();
    const parts = enc.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => v.decrypt(parts.join(':'), 'youtube')).toThrow();
  });

  it('link temporário assinado vale só para o arquivo e o prazo', () => {
    const s = Buffer.alloc(32, 3);
    const tok = signMediaToken(s, 'real:abc.mp4', 2000);
    expect(verifyMediaToken(s, tok, 1000)).toBe('real:abc.mp4');
    expect(verifyMediaToken(s, tok, 3000)).toBeNull();
    expect(verifyMediaToken(Buffer.alloc(32, 4), tok, 1000)).toBeNull();
  });

  it('logs mascaram tokens', () => {
    const out = redact('GET /x?access_token=EAAB123&code=abc Authorization: Bearer ya29.xyz');
    expect(out).not.toMatch(/EAAB123|ya29|=abc/);
  });
});
