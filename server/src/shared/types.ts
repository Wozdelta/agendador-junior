// Tipos compartilhados entre backend e frontend.
// Nada aqui pode conter segredo: este arquivo também entra no bundle React.

export const PLATFORMS = ['facebook', 'youtube', 'instagram', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];

export type AppMode = 'demo' | 'real';

export const PLATFORM_LABEL: Record<Platform, string> = {
  facebook: 'Facebook Reels',
  youtube: 'YouTube Shorts',
  instagram: 'Instagram Reels',
  tiktok: 'TikTok',
};

/** Estados exibidos na agenda. */
export type TaskState =
  | 'draft'
  | 'queued'
  | 'processing'
  | 'scheduled_remote'
  | 'published'
  | 'manual_action'
  | 'late'
  | 'failed'
  | 'cancelled';

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  draft: 'Rascunho',
  queued: 'Na fila do aplicativo',
  processing: 'Em processamento',
  scheduled_remote: 'Agendado na plataforma',
  published: 'Publicado',
  manual_action: 'Ação manual necessária',
  late: 'Atrasado',
  failed: 'Falha',
  cancelled: 'Cancelado',
};

/** Motivo de uma "Ação manual necessária". */
export type ManualReason =
  | 'tiktok_manual' // TikTok sem API: publicar manualmente
  | 'tiktok_inbox' // Enviado ao TikTok (caixa de entrada): finalizar no app
  | 'platform_manual' // plataforma sem execução futura nesta arquitetura
  | 'review_unknown'; // resultado remoto desconhecido: revisar na plataforma

export type CoverState = 'none' | 'pending' | 'applied' | 'frame' | 'manual' | 'failed';

export interface PlatformTexts {
  enabled: boolean;
  title: string;
  description: string;
  /** YouTube: escolha explícita (null = ainda não escolhido). */
  madeForKids?: boolean | null;
  /** TikTok Direct Post */
  privacyLevel?: string | null;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  directPostConsent?: boolean;
}

export interface MediaInfo {
  id: string;
  kind: 'video' | 'image';
  originalName: string;
  mime: string;
  size: number;
  durationSec?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  container?: string;
  /** URL para prévia/download (relativa no acesso local; link assinado no acesso remoto). */
  url?: string;
}

export interface BatchItemDTO {
  id: string;
  order: number;
  uploadStatus: 'pending' | 'uploading' | 'ready' | 'error';
  uploadError?: string;
  originalName: string;
  media?: MediaInfo;
  cover?: MediaInfo;
  /** Quadro escolhido como capa (ms) para plataformas que só aceitam quadro. */
  coverFrameMs: number;
  scheduledAt: string; // ISO UTC calculado no servidor
  scheduledLocal: string; // "DD/MM/AAAA HH:mm" em America/Sao_Paulo
  platforms: Record<Platform, PlatformTexts>;
  /** Destino do upload do vídeo e da capa (PUT multipart). */
  uploadUrl: string;
  coverUploadUrl: string;
}

export interface BatchDTO {
  id: string;
  mode: AppMode;
  status: 'draft' | 'confirmed';
  startDate: string; // DD/MM/AAAA
  timezone: string;
  publishTime: string; // HH:mm
  platforms: Record<Platform, boolean>;
  items: BatchItemDTO[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface Issue {
  level: 'error' | 'warning' | 'info';
  platform?: Platform;
  itemId?: string;
  field?: string;
  message: string;
}

export interface BatchSummary {
  batchId: string;
  canConfirm: boolean;
  issues: Issue[];
  rows: Array<{
    itemId: string;
    order: number;
    originalName: string;
    scheduledLocal: string;
    platforms: Array<{ platform: Platform; account: string | null; mode: string }>;
  }>;
}

export interface TaskDTO {
  id: string;
  mode: AppMode;
  batchId: string;
  itemId: string;
  platform: Platform;
  accountId: string;
  accountName: string;
  state: TaskState;
  manualReason?: ManualReason;
  plannedAt: string;
  plannedLocal: string;
  effectiveAt?: string;
  effectiveLocal?: string;
  attempts: number;
  nextRunAt?: string;
  lastError?: string;
  delayNote?: string;
  remoteId?: string;
  remoteUrl?: string;
  nativeSchedule: boolean;
  publishedManually?: boolean;
  cover: { state: CoverState; message?: string };
  videoUploaded: boolean;
  originalName: string;
  mediaId?: string;
  coverId?: string;
  mediaUrl?: string;
  coverUrl?: string;
  title: string;
  description: string;
  history: Array<{ at: string; message: string }>;
  actions: TaskAction[];
}

export type TaskAction =
  | 'edit'
  | 'cancel'
  | 'retry'
  | 'reschedule'
  | 'manual_complete'
  | 'resolve_review';

export interface ConnectionDTO {
  schedulerConfigured?: boolean;
  analytics?: { state: import('./analytics.js').DataState; missingScopes: string[]; lastSync?: string };
  monetization?: 'permission_granted' | 'unavailable';
  canConnect?: boolean;
  /** Motivos acionáveis; nunca inclui valores de credenciais. */
  blockers?: string[];
  platform: Platform;
  configured: boolean; // credenciais do app presentes no .env
  connected: boolean;
  accountName?: string;
  accountId?: string;
  /** Facebook: páginas autorizadas. */
  pages?: Array<{ id: string; name: string; instagram?: { id: string; username: string } | null }>;
  selectedPageId?: string;
  capabilities: string[];
  notes: string[];
  needsReconnect?: boolean;
}

export interface SettingsDTO {
  serverPersistence?: boolean;
  mediaPersistence?: boolean;
  oauthAvailable?: boolean;
  backgroundWorker?: boolean;
  mode: AppMode;
  timezone: string;
  publishTime: string;
  lateToleranceMinutes: number;
  minLeadMinutes: number;
  publicBaseUrlConfigured: boolean;
  tiktokMode: 'manual' | 'inbox' | 'direct';
  graphVersion: string;
  /** Interface aberta pela Vercel (via proxy) em vez de localhost. */
  remoteAccess: boolean;
  /** Uploads e mídia vão direto ao backend (PUBLIC_BASE_URL configurado). */
  directLinks: boolean;
}
