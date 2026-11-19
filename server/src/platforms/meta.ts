// Meta Graph API (versão configurável, padrão v27.0 — consultada em 14/11/2026).
// Login do Facebook no servidor, listagem de Páginas, token de Página e
// Instagram profissional vinculado à Página.
import type { AppContext, ModeContext } from '../context.js';
import { AppError, AuthError, PermanentError, RetryableError } from '../lib/errors.js';
import { form, parseRetryAfter, request, type HttpResponse } from '../lib/http.js';
import { getConn, markNeedsReconnect } from './tokens.js';

export const META_SCOPES = [
  'pages_show_list', // listar Páginas
  'pages_read_engagement', // ler Página, status do vídeo e Reels
  'pages_manage_posts', // publicar e agendar Reels na Página
  'instagram_basic', // ler a conta profissional vinculada
  'instagram_content_publish', // criar containers e publicar Reels
  'business_management', // Páginas administradas pelo Gerenciador de Negócios
];

export function graphBase(ctx: AppContext): string {
  return `https://graph.facebook.com/${ctx.config.meta.graphVersion}`;
}

export function metaAuthUrl(ctx: AppContext, state: string): string {
  const p = new URLSearchParams({
    client_id: ctx.config.meta.appId,
    redirect_uri: ctx.config.meta.redirectUri,
    state,
    response_type: 'code',
  });
  // Facebook Login for Business usa config_id (configuração com as permissões); senão, escopos.
  if (ctx.config.meta.configId) p.set('config_id', ctx.config.meta.configId);
  else p.set('scope', META_SCOPES.join(','));
  return `https://www.facebook.com/${ctx.config.meta.graphVersion}/dialog/oauth?${p}`;
}

/** Converte erros da Graph API em erros da fila. */
export function metaError(res: HttpResponse, what: string): Error {
  const e = res.json?.error ?? {};
  const code = Number(e.code);
  const msg = e.error_user_msg || e.message || `HTTP ${res.status}`;
  if (code === 190 || res.status === 401) return new AuthError(`${what}: token da Meta expirado ou revogado. Reconecte o Facebook.`);
  if ([4, 17, 32, 613, 80001, 80002, 80004].includes(code) || res.status === 429) {
    return new RetryableError(`${what}: limite de uso da Meta atingido (${msg}).`, parseRetryAfter(res.headers.get('retry-after')) ?? 15 * 60_000, 'rate_limit');
  }
  if (code === 9 || code === 9004 || code === 2207042) {
    return new RetryableError(`${what}: limite de publicação atingido (${msg}).`, 60 * 60_000, 'rate_limit');
  }
  if (e.is_transient || [1, 2].includes(code) || res.status >= 500) return new RetryableError(`${what}: erro temporário da Meta (${msg}).`);
  if (code === 10 || code === 200 || (code >= 200 && code < 300)) {
    return new PermanentError(`${what}: permissão ausente (${msg}). Confira os escopos e a função na Página.`);
  }
  return new PermanentError(`${what}: ${msg}`);
}

export async function graph(
  ctx: AppContext,
  path: string,
  opts: { method?: string; token: string; params?: Record<string, any>; mayCreate?: boolean; what: string },
): Promise<any> {
  const method = opts.method ?? 'GET';
  const params = form({ ...(opts.params ?? {}), access_token: opts.token });
  const url = method === 'GET' || method === 'DELETE' ? `${graphBase(ctx)}${path}?${params}` : `${graphBase(ctx)}${path}`;
  const res = await request(url, {
    method,
    fetchImpl: ctx.fetch,
    mayCreate: opts.mayCreate,
    headers: method === 'GET' || method === 'DELETE' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' || method === 'DELETE' ? undefined : params,
  });
  if (res.status !== 200 || res.json?.error) throw metaError(res, opts.what);
  return res.json;
}

export async function metaExchange(ctx: AppContext, mc: ModeContext, code: string): Promise<void> {
  const { appId, appSecret, redirectUri } = ctx.config.meta;
  const short = await request(
    `${graphBase(ctx)}/oauth/access_token?${form({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })}`,
    { fetchImpl: ctx.fetch },
  );
  if (short.status !== 200) throw new AppError(400, `A Meta recusou a autorização: ${short.json?.error?.message ?? short.status}`);
  // Token de usuário de longa duração -> tokens de Página sem expiração.
  const long = await request(
    `${graphBase(ctx)}/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.json.access_token })}`,
    { fetchImpl: ctx.fetch },
  );
  const userToken: string = long.json?.access_token ?? short.json.access_token;
  const me = await graph(ctx, '/me', { token: userToken, params: { fields: 'id,name' }, what: 'Leitura do perfil' });
  const perms = await graph(ctx, '/me/permissions', { token: userToken, what: 'Leitura das permissões' });
  const granted = (perms.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
  const pagesRes = await graph(ctx, '/me/accounts', {
    token: userToken,
    params: { fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: 100 },
    what: 'Listagem de Páginas',
  });
  const missing = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_content_publish'].filter(p => !granted.includes(p));
  if (!(pagesRes.data ?? []).length) {
    throw new AppError(400, missing.length
      ? `A Meta não liberou as permissões de Página (${missing.join(', ')}). ${ctx.config.meta.configId ? 'A configuração do Facebook Login for Business (META_LOGIN_CONFIG_ID) precisa incluir essas permissões e usar "Token de acesso do usuário"; ou remova META_LOGIN_CONFIG_ID na Vercel.' : 'Entre novamente e marque todas as Páginas e permissões.'}`
      : 'Nenhuma Página do Facebook foi retornada. Entre novamente e selecione a Página ligada ao Instagram.');
  }
  const pages = (pagesRes.data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    tokenEnc: ctx.vault.encrypt(p.access_token, `facebook-page:${p.id}`),
    instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null,
  }));
  await mc.connections.mutate((d) => {
    const prev = d.facebook?.selectedPageId;
    d.facebook = {
      tokensEnc: ctx.vault.encrypt({ access_token: userToken }, 'facebook'),
      accountId: me.id,
      accountName: me.name,
      scopes: granted,
      pages,
      selectedPageId: pages.some((p: any) => p.id === prev) ? prev : pages.length === 1 ? pages[0].id : undefined,
      connectedAt: ctx.clock.now().toISOString(),
      needsReconnect: false,
      instagramDisconnected: false,
    };
  });
}

export interface PageAccess {
  pageId: string;
  pageName: string;
  token: string;
  instagram: { id: string; username: string } | null;
}

/** Página selecionada e seu token (descriptografado só na memória do servidor). */
export function selectedPage(ctx: AppContext, mc: ModeContext): PageAccess {
  const c = getConn(mc, 'facebook');
  if (!c?.tokensEnc) throw new AuthError('Facebook não conectado. Abra "Conexões".');
  if (c.needsReconnect) throw new AuthError('A autorização do Facebook expirou. Reconecte em "Conexões".');
  const page = c.pages?.find((p) => p.id === c.selectedPageId);
  if (!page) throw new AuthError('Escolha a Página de destino em "Conexões".');
  return {
    pageId: page.id,
    pageName: page.name,
    token: ctx.vault.decrypt<string>(page.tokenEnc, `facebook-page:${page.id}`),
    instagram: c.instagramDisconnected ? null : page.instagram ?? null,
  };
}

export async function handleMetaAuthFailure(mc: ModeContext, err: unknown): Promise<void> {
  if (err instanceof AuthError) await markNeedsReconnect(mc, 'facebook');
}
