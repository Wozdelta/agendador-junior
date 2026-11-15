import { PLATFORMS, type Platform } from '../../../server/src/shared/types';
import { isoToBr, isValidBrDate } from './date';

export const MANUAL_AGENDA_KEY = 'agendador-junior:agenda-manual:v1';
export interface ManualEntry {
  id: string;
  date: string;
  originalName: string;
  title: string;
  description: string;
  platforms: Partial<Record<Platform, boolean>>; // false = pendente; true = concluído manualmente
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export function readManualAgenda(storage: StorageLike): ManualEntry[] {
  const text = storage.getItem(MANUAL_AGENDA_KEY);
  if (!text) return [];
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows) || rows.some(r => !r || typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.originalName !== 'string' || typeof r.description !== 'string' || typeof r.date !== 'string' || !isValidBrDate(isoToBr(r.date)) || !r.platforms || Object.entries(r.platforms).some(([p, done]) => !PLATFORMS.includes(p as Platform) || typeof done !== 'boolean'))) {
    throw new Error('Agenda manual inválida. Preserve os dados deste navegador antes de tentar novamente.');
  }
  return rows;
}
export function saveManualAgenda(storage: StorageLike, rows: ManualEntry[]): void {
  storage.setItem(MANUAL_AGENDA_KEY, JSON.stringify(rows));
}
export function manualDates(start: string, count: number): string[] {
  if (!isValidBrDate(isoToBr(start))) throw new Error('Escolha uma data válida.');
  const first = new Date(`${start}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(first.getTime() + i * 86400_000).toISOString().slice(0, 10));
}
export function markManualPlatform(rows: ManualEntry[], id: string, platform: Platform): ManualEntry[] {
  return rows.map(r => r.id !== id || r.platforms[platform] === undefined ? r : { ...r, platforms: { ...r.platforms, [platform]: !r.platforms[platform] } });
}
