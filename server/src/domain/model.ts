import type {
  AppMode,
  CoverState,
  ManualReason,
  MediaInfo,
  Platform,
  PlatformTexts,
  TaskState,
} from '../shared/types.js';

export interface MediaRecord extends MediaInfo {
  internalName: string; // nome gerado (disco) ou pathname no Blob; o nome original nunca vira caminho
  /** URL no Vercel Blob (produção na Vercel). Sem ela, o arquivo está em DATA_DIR. */
  storagePath?: string;
  blobUrl?: string;
  createdAt: string;
}

export interface BatchItem {
  id: string;
  order: number;
  uploadStatus: 'pending' | 'uploading' | 'ready' | 'error';
  uploadError?: string;
  originalName: string;
  expectedSize?: number;
  mediaId?: string;
  coverId?: string;
  coverFrameMs: number;
  scheduledAt: string;
  platforms: Record<Platform, PlatformTexts>;
}

export interface Batch {
  id: string;
  mode: AppMode;
  status: 'draft' | 'confirmed';
  startDate: string; // AAAA-MM-DD
  timezone: string;
  publishTime: string;
  platforms: Record<Platform, boolean>;
  items: BatchItem[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface TaskHistory {
  at: string;
  message: string;
}

export interface Task {
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
  effectiveAt?: string;
  attempts: number;
  nextRunAt?: string;
  lastError?: string;
  delayNote?: string;
  /** Etapa interna do conector (persistida para retomar após reinício). */
  phase: string;
  /** Identificadores remotos e dados de retomada (sessão de upload, container etc.). */
  remote: Record<string, any>;
  remoteId?: string;
  remoteUrl?: string;
  nativeSchedule: boolean;
  publishedManually?: boolean;
  cover: { state: CoverState; message?: string };
  videoUploaded: boolean;
  // Cópia dos dados do vídeo no momento da confirmação
  originalName: string;
  mediaId: string;
  coverId?: string;
  coverFrameMs: number;
  title: string;
  description: string;
  options: Partial<PlatformTexts>;
  /** Trava com validade (lease): impede que duas execuções processem a mesma tarefa. */
  lock?: { bootId: string; at: string; until?: string };
  history: TaskHistory[];
  createdAt: string;
  updatedAt: string;
}

export interface IdemRecord {
  id: string; // escopo + chave
  status: 'pending' | 'done';
  httpStatus?: number;
  body?: unknown;
  createdAt: string;
}

export interface StoredConnection {
  analyticsTokensEnc?: string;
  analyticsScopes?: string[];
  analyticsPages?: StoredConnection['pages'];
  analyticsNeedsReconnect?: boolean;
  analyticsVerifiedAt?: string;
  instagramDisconnected?: boolean;
  tokensEnc?: string;
  accountId?: string;
  accountName?: string;
  scopes?: string[];
  needsReconnect?: boolean;
  connectedAt?: string;
  // Facebook / Instagram
  pages?: Array<{ id: string; name: string; tokenEnc: string; instagram?: { id: string; username: string } | null }>;
  selectedPageId?: string;
}

export interface ConnectionsDoc {
  youtube?: StoredConnection;
  facebook?: StoredConnection;
  tiktok?: StoredConnection;
}

export const ACTIVE_STATES: TaskState[] = ['queued', 'processing', 'scheduled_remote', 'manual_action'];

export function emptyTexts(): Record<Platform, PlatformTexts> {
  return {
    facebook: { enabled: true, title: '', description: '' },
    youtube: { enabled: true, title: '', description: '', madeForKids: null },
    instagram: { enabled: true, title: '', description: '' },
    tiktok: {
      enabled: true,
      title: '',
      description: '',
      privacyLevel: null,
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      directPostConsent: false,
    },
  };
}
