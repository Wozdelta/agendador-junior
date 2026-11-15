// Vercel Function: encaminha /api/* da interface hospedada para o backend Node
// persistente (BACKEND_URL), que roda a fila, guarda mídia e tokens e recebe os
// callbacks OAuth. Só JSON passa por aqui (limite de 4,5 MB no corpo); vídeos e
// capas vão direto ao backend por links assinados (/direct/*).
//
// Variáveis (somente no servidor da Vercel, nunca no bundle):
//   BACKEND_URL           ex.: https://api.seu-dominio.com  (sem barra no final)
//   BACKEND_PROXY_SECRET  mesmo valor configurado no backend
declare const process: { env: Record<string, string | undefined> };

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
]);
// Sem login no app: cookies não são repassados em nenhum sentido.
const FORWARD_REQUEST = ['accept', 'content-type', 'idempotency-key', 'origin', 'range', 'user-agent'];

async function handler(request: Request): Promise<Response> {
  const backend = (process.env.BACKEND_URL ?? '').replace(/\/+$/, '');
  const secret = process.env.BACKEND_PROXY_SECRET ?? '';
  if (!backend || !secret) {
    return Response.json(
      { error: 'Backend não configurado na Vercel (BACKEND_URL e BACKEND_PROXY_SECRET).', code: 'backend_not_configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const incoming = new URL(request.url);
  // vercel.json reescreve /api/<caminho> para /api/proxy?__path=<caminho>
  const subpath = incoming.searchParams.get('__path') ?? '';
  incoming.searchParams.delete('__path');
  if (!/^[A-Za-z0-9/_\-.]*$/.test(subpath) || subpath.includes('..')) {
    return Response.json({ error: 'Caminho inválido.' }, { status: 400 });
  }
  const qs = incoming.searchParams.toString();
  const target = `${backend}/api/${subpath}${qs ? `?${qs}` : ''}`;

  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('x-agendador-proxy', secret);
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  if (ip) headers.set('x-forwarded-for', ip);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual', // OAuth: o 302 para Google/Meta/TikTok volta ao navegador
    });
  } catch {
    return Response.json(
      { error: 'Não foi possível falar com o backend. Verifique se ele está ligado e se BACKEND_URL está correto.', code: 'backend_unreachable' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie') out.set(k, v);
  });
  out.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
