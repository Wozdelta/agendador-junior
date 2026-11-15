import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src -> raiz do projeto (também funciona a partir de server/dist)
export const PROJECT_ROOT = path.resolve(here, '..', '..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true } as dotenv.DotenvConfigOptions);

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variável ${name} inválida: "${v}"`);
  return n;
}
function bool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase());
}
function str(name: string, def = ''): string {
  return process.env[name] ?? def;
}

export interface Config {
  host: string;
  port: number;
  webOrigin: string;
  dataDir: string;
  timezone: string;
  publishTime: string;
  minLeadMinutes: number;
  lateToleranceMinutes: number;
  maxAttempts: number;
  workerTickMs: number;
  workerConcurrency: number;
  maxVideoBytes: number;
  maxImageBytes: number;
  ffprobePath: string;
  ffmpegPath: string;
  tokenKey: string; // base64 de 32 bytes
  publicBaseUrl: string;
  mediaLinkTtlMinutes: number;
  /** Endereço público da interface (ex.: https://seu-app.vercel.app). Libera CORS/redirects para ele. */
  appUrl: string;
  /** local = Node no seu computador; vercel = Vercel Functions (detectado por VERCEL=1). */
  runtime: 'local' | 'vercel';
  /** Supabase em producao; tipos file/redis restritos a adaptadores legados e testes. */
  storage: 'file' | 'redis' | 'supabase';
  adminEmail: string;
  supabase: { url: string; publishableKey: string; secretKey: string };
  redis: { url: string; token: string; prefix: string };
  /** Upload real usa o bucket privado do Supabase; manual guarda apenas nomes. */
  mediaStorage: 'disk' | 'supabase';
  /** Tempo que uma execução da fila usa antes de parar de pegar tarefas novas (ms). */
  tickBudgetMs: number;
  publicationSchedulerEnabled: boolean;
  /** Validade da trava de uma tarefa em execução (ms). */
  taskLeaseMs: number;
  google: { clientId: string; clientSecret: string; redirectUri: string };
  meta: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    graphVersion: string;
    configId: string; // Facebook Login for Business (opcional)
    reelsCustomCover: boolean;
    allowDirectPublishFallback: boolean;
    igResumable: boolean;
    igContainerLeadMinutes: number;
  };
  tiktok: {
    clientKey: string;
    clientSecret: string;
    redirectUri: string;
    uploadApproved: boolean;
    directPostApproved: boolean;
    inboxLeadMinutes: number;
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = num('PORT', 3001);
  const vercel = process.env.VERCEL === '1';
  const base: Config = {
    host: str('HOST', '127.0.0.1'),
    port,
    webOrigin: str('WEB_ORIGIN', 'http://localhost:5173'),
    // Na Vercel só /tmp é gravável (usado apenas como área temporária).
    dataDir: vercel ? '/tmp/agendador' : path.resolve(PROJECT_ROOT, str('DATA_DIR', 'data')),
    timezone: 'America/Sao_Paulo',
    publishTime: '12:00',
    minLeadMinutes: num('MIN_LEAD_MINUTES', 15),
    lateToleranceMinutes: num('LATE_TOLERANCE_MINUTES', 20),
    maxAttempts: num('MAX_ATTEMPTS', 6),
    workerTickMs: num('WORKER_TICK_MS', 5000),
    workerConcurrency: num('WORKER_CONCURRENCY', 2),
    maxVideoBytes: num('MAX_VIDEO_MB', 50) * 1024 * 1024,
    maxImageBytes: num('MAX_IMAGE_MB', 8) * 1024 * 1024,
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    tokenKey: str('TOKEN_ENCRYPTION_KEY'),
    publicBaseUrl: str('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    mediaLinkTtlMinutes: num('MEDIA_LINK_TTL_MINUTES', 120),
    appUrl: (str('APP_URL') || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') || (vercel ? 'https://agendador-junior.vercel.app' : '')).replace(/\/+$/, ''),
    runtime: vercel ? 'vercel' : 'local',
    storage: str('SUPABASE_URL') ? 'supabase' : 'file',
    adminEmail: str('Login_ADM').trim().toLowerCase(),
    supabase: { url: str('SUPABASE_URL'), publishableKey: str('SUPABASE_PUBLISHABLE_KEY'), secretKey: str('SUPABASE_SECRET_KEY') },
    redis: { url: '', token: '', prefix: 'legacy' },
    mediaStorage: str('SUPABASE_URL') ? 'supabase' : 'disk',
    tickBudgetMs: num('TICK_BUDGET_SECONDS', vercel ? 240 : 3600) * 1000,
    publicationSchedulerEnabled: bool('PUBLICATION_SCHEDULER_ENABLED'),
    taskLeaseMs: num('TASK_LEASE_MINUTES', vercel ? 6 : 30) * 60_000,
    google: {
      clientId: str('GOOGLE_CLIENT_ID'),
      clientSecret: str('GOOGLE_CLIENT_SECRET'),
      redirectUri: str('GOOGLE_REDIRECT_URI', `http://localhost:${port}/api/oauth/youtube/callback`),
    },
    meta: {
      appId: str('META_APP_ID'),
      appSecret: str('META_APP_SECRET'),
      redirectUri: str('META_REDIRECT_URI', `http://localhost:${port}/api/oauth/facebook/callback`),
      graphVersion: str('META_GRAPH_VERSION', 'v27.0'),
      configId: str('META_LOGIN_CONFIG_ID'),
      reelsCustomCover: bool('META_REELS_CUSTOM_COVER', false),
      allowDirectPublishFallback: bool('META_ALLOW_DIRECT_PUBLISH_FALLBACK', false),
      igResumable: bool('IG_RESUMABLE_UPLOAD', false),
      igContainerLeadMinutes: num('IG_CONTAINER_LEAD_MINUTES', 60),
    },
    tiktok: {
      clientKey: str('TIKTOK_CLIENT_KEY'),
      clientSecret: str('TIKTOK_CLIENT_SECRET'),
      redirectUri: str('TIKTOK_REDIRECT_URI'),
      uploadApproved: bool('TIKTOK_VIDEO_UPLOAD_APPROVED', false),
      directPostApproved: bool('TIKTOK_DIRECT_POST_APPROVED', false),
      inboxLeadMinutes: num('TIKTOK_INBOX_LEAD_MINUTES', 30),
    },
  };
  // Na Vercel, os callbacks padrão apontam para o próprio domínio do app.
  if (vercel && base.appUrl) {
    if (!process.env.PUBLIC_BASE_URL) base.publicBaseUrl = base.appUrl;
    const cb = (p: string) => `${base.appUrl}/api/oauth/${p}/callback`;
    if (!process.env.GOOGLE_REDIRECT_URI) base.google.redirectUri = cb('youtube');
    if (!process.env.META_REDIRECT_URI) base.meta.redirectUri = cb('facebook');
    if (!process.env.TIKTOK_REDIRECT_URI) base.tiktok.redirectUri = cb('tiktok');
    if (!process.env.WEB_ORIGIN) base.webOrigin = base.appUrl;
  }
  const config = { ...base, ...overrides };
  // Preserve a chave dedicada já usada por tokens antigos. Projetos novos não
  // precisam cadastrar outro segredo além do Supabase: HKDF separa os usos.
  if (!config.tokenKey && config.storage === 'supabase' && config.supabase.secretKey) {
    config.tokenKey = Buffer.from(crypto.hkdfSync(
      'sha256', Buffer.from(config.supabase.secretKey, 'utf8'), Buffer.alloc(0),
      'agendador-junior:oauth-encryption:v1', 32,
    )).toString('base64');
  }
  return config;
}
