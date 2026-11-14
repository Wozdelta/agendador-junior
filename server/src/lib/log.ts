/** Logger que mascara tokens, segredos e códigos OAuth antes de escrever. */
const PATTERNS: RegExp[] = [
  /(access_token|refresh_token|client_secret|code|token|authorization)(["'=:\s]+)([^"'&\s,}]+)/gi,
  /(Bearer|OAuth)\s+[A-Za-z0-9._\-~+/=]+/g,
];
export function redact(text: string): string {
  let out = text;
  // Primeiro "Bearer xxx"/"OAuth xxx", senão o padrão de chave=valor consumiria só a palavra "Bearer".
  out = out.replace(PATTERNS[1], (_m, k) => `${k} ***`);
  out = out.replace(PATTERNS[0], (m, k, sep, v) => (v === '***' ? m : `${k}${sep}***`));
  return out;
}
function fmt(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}
let silent = false;
export const log = {
  setSilent(v: boolean) {
    silent = v;
  },
  info: (...a: unknown[]) => !silent && console.log(`[${new Date().toISOString()}]`, redact(fmt(a))),
  warn: (...a: unknown[]) => !silent && console.warn(`[${new Date().toISOString()}] AVISO`, redact(fmt(a))),
  error: (...a: unknown[]) => !silent && console.error(`[${new Date().toISOString()}] ERRO`, redact(fmt(a))),
};
