import type { Platform } from './types.js';
export type DataState = 'available' | 'no_data' | 'permission' | 'unavailable' | 'expired' | 'disconnected' | 'temporary_error';
export type MetricKey = 'followers' | 'gained' | 'lost' | 'net' | 'views' | 'reach' | 'uniqueViewers' | 'likes' | 'comments' | 'shares' | 'saves' | 'interactions' | 'watchHours' | 'averageSeconds' | 'retention' | 'revenue';
export interface Metric {
  value: number | null; state: DataState; basis: 'current' | 'period' | 'lifetime' | 'snapshot_delta';
  source: string; definition?: string; currency?: string; unit?: string;
  collectedAt?: string; stale?: boolean;
  complete?: boolean; coverageStart?: string; coverageEnd?: string;
}
export type Metrics = Partial<Record<MetricKey, Metric>>;
export interface AnalyticsContent {
  id: string; title: string; url: string; thumbnail?: string; publishedAt?: string; type?: string;
  platform: Platform; metrics: Metrics; basis: 'period' | 'lifetime';
}
export interface AnalyticsReport {
  platform: Platform; accountId: string; accountName: string; avatar?: string;
  start: string; end: string; collectedAt: string; metrics: Metrics;
  daily: Array<{ date: string; metrics: Metrics }>;
  content: AnalyticsContent[]; notes: string[]; complete: boolean; timezone: string;
  coverageStart?: string; coverageEnd?: string;
  contentTypes?: Array<{ type: string; metrics: Metrics }>;
}
export interface AnalyticsPlatform {
  platform: Platform; accountId?: string; accountName?: string; avatar?: string;
  state: DataState; missingScopes: string[]; lastAttempt?: string; lastSuccess?: string;
  message?: string; report?: AnalyticsReport; previous?: AnalyticsReport;
  snapshots: Array<{ date: string; value: number }>;
  collectionStartedAt?: string; retryAt?: string;
}
export interface AnalyticsDTO { start: string; end: string; platforms: AnalyticsPlatform[]; }
export const METRIC_LABEL: Record<MetricKey,string> = {
  followers:'Seguidores', gained:'Ganhos', lost:'Perdas', net:'Saldo', views:'Visualizações', reach:'Alcance', uniqueViewers:'Público único', likes:'Curtidas', comments:'Comentários', shares:'Compartilhamentos', saves:'Salvamentos', interactions:'Interações', watchHours:'Horas assistidas', averageSeconds:'Duração média (s)', retention:'Retenção média (%)', revenue:'Receita estimada',
};
export const STATE_LABEL: Record<DataState,string> = { available:'Disponível', no_data:'Sem dados', permission:'Permissão necessária', unavailable:'Indisponível nesta integração', expired:'Token expirado', disconnected:'Conta desconectada', temporary_error:'Erro temporário' };
