/** Máscara DD/MM/AAAA enquanto o usuário digita. */
export function maskBrDate(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** Valida DD/MM/AAAA como data existente do calendário. */
export function isValidBrDate(v: string): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (!m) return false;
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export const brToIso = (v: string) => (isValidBrDate(v) ? `${v.slice(6)}-${v.slice(3, 5)}-${v.slice(0, 2)}` : '');
export const isoToBr = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '');

/** Hoje em America/Sao_Paulo no formato AAAA-MM-DD. */
export function todayIsoSaoPaulo(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatSec(s?: number): string {
  if (s === undefined) return '—';
  const r = Math.round(s);
  return r >= 60 ? `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')} min` : `${r} s`;
}
