import { DateTime } from 'luxon';
import type { AnalyticsReport, DataState, Metric, Metrics } from '../shared/analytics.js';
import type { Platform } from '../shared/types.js';
import type { AppContext } from '../context.js';
import { request } from '../lib/http.js';

export class AnalyticsError extends Error {
  constructor(public state: DataState, public retryAt?: string) { super(state); }
}
export function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  return (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)) ? Number(value) : null;
}
export function metric(value: unknown, source: string, basis: Metric['basis'] = 'period', extra: Partial<Metric> = {}): Metric {
  const n = number(value); return { value:n, state:n === null ? 'no_data' : 'available', source, basis, ...extra };
}
export function absent(state: DataState, source: string, basis: Metric['basis'] = 'period'): Metric { return { value:null, state, source, basis }; }
export function range(start?: unknown, end?: unknown, now = new Date()) {
  const yesterday = DateTime.fromJSDate(now).setZone('America/Sao_Paulo').minus({days:1}).startOf('day');
  const a = start ? DateTime.fromISO(String(start),{zone:'UTC'}) : yesterday.minus({days:27});
  const b = end ? DateTime.fromISO(String(end),{zone:'UTC'}) : yesterday;
  const days = Math.round(b.startOf('day').toUTC().diff(a.startOf('day').toUTC(),'days').days)+1;
  if (!a.isValid || !b.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(a.toISODate() ?? '') || days < 1 || days > 90 || b.toISODate()! > yesterday.toISODate()!) throw new AnalyticsError('unavailable');
  return {start:a.toISODate()!, end:b.toISODate()!, days, previousStart:a.minus({days}).toISODate()!, previousEnd:a.minus({days:1}).toISODate()!};
}
export async function json(ctx: AppContext, url: string, token: string, body?: unknown): Promise<any> {
  // Never follow remote pagination URLs or expose provider error bodies containing credentials.
  const res = await request(url, {fetchImpl:ctx.fetch, timeoutMs:15_000, method:body === undefined ? 'GET':'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:body === undefined ? undefined:JSON.stringify(body)});
  const error = res.json?.error;
  if (res.status === 401 || error?.code === 190 || ['access_token_invalid','invalid_grant'].includes(error?.code)) throw new AnalyticsError('expired');
  if (res.status === 429 || res.status >= 500 || ['rate_limit_exceeded',4,17,32,613].includes(error?.code)) {
    const retry = Number(res.headers.get('retry-after'));
    throw new AnalyticsError('temporary_error', new Date(ctx.clock.now().getTime()+(Number.isFinite(retry)&&retry>0?retry:900)*1000).toISOString());
  }
  if (res.status === 403 || [10,200,'scope_not_authorized'].includes(error?.code)) throw new AnalyticsError('permission');
  if (res.status !== 200 || (error && error.code !== 'ok')) throw new AnalyticsError('unavailable');
  if (!res.json) throw new AnalyticsError('temporary_error');
  return res.json;
}
export async function optional<T>(fn: () => Promise<T>, fallback: (state: DataState) => T): Promise<T> {
  try { return await fn(); } catch(e) { if (e instanceof AnalyticsError && e.state !== 'expired' && e.state !== 'temporary_error') return fallback(e.state); throw e; }
}
export function base(ctx: AppContext, platform: Platform, accountId: string, accountName: string, start: string, end: string): AnalyticsReport {
  return {platform, accountId, accountName, start,end,collectedAt:ctx.clock.now().toISOString(),metrics:{},daily:[],content:[],notes:[],complete:false,timezone:platform === 'youtube' ? 'America/Los_Angeles' : 'UTC'};
}
export function sum(rows: Metrics[], key: keyof Metrics): number | null {
  const values = rows.map(r=>r[key]?.value).filter((v):v is number=>v !== null && v !== undefined);
  return values.length ? values.reduce((a,b)=>a+b,0) : null;
}
