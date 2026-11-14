import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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
  /** Segredo compartilhado com a Function de proxy da Vercel (cabeçalho x-agendador-proxy). */
  proxySecret: string;
  /** Hash scrypt da senha de acesso remoto (gere com: npm run hash-password -w server). */
  appPasswordHash: string;
  sessionDays: number;
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
  const base: Config = {
    host: str('HOST', '127.0.0.1'),
    port,
    webOrigin: str('WEB_ORIGIN', 'http://localhost:5173'),
    dataDir: path.resolve(PROJECT_ROOT, str('DATA_DIR', 'data')),
    timezone: str('TIMEZONE', 'America/Sao_Paulo'),
    publishTime: str('PUBLISH_TIME', '12:00'),
    minLeadMinutes: num('MIN_LEAD_MINUTES', 15),
    lateToleranceMinutes: num('LATE_TOLERANCE_MINUTES', 20),
    maxAttempts: num('MAX_ATTEMPTS', 6),
    workerTickMs: num('WORKER_TICK_MS', 5000),
    workerConcurrency: num('WORKER_CONCURRENCY', 2),
    maxVideoBytes: num('MAX_VIDEO_MB', 1024) * 1024 * 1024,
    maxImageBytes: num('MAX_IMAGE_MB', 8) * 1024 * 1024,
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    tokenKey: str('TOKEN_ENCRYPTION_KEY'),
    publicBaseUrl: str('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    mediaLinkTtlMinutes: num('MEDIA_LINK_TTL_MINUTES', 120),
    appUrl: str('APP_URL').replace(/\/+$/, ''),
    proxySecret: str('BACKEND_PROXY_SECRET'),
    appPasswordHash: str('APP_PASSWORD_HASH'),
    sessionDays: num('SESSION_DAYS', 7),
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
  return { ...base, ...overrides };
}
