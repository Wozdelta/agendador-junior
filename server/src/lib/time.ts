import { DateTime } from 'luxon';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** "DD/MM/AAAA" -> "AAAA-MM-DD" ou null se a data não existir no calendário. */
export function parseBrDate(input: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((input ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const dt = DateTime.fromObject({ year: +yyyy, month: +mm, day: +dd }, { zone: 'UTC' });
  if (!dt.isValid || dt.day !== +dd || dt.month !== +mm) return null;
  return dt.toISODate();
}

export function isoToBrDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function parseTime(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Horário inválido: ${hhmm}`);
  return { hour: +m[1], minute: +m[2] };
}

/**
 * Calcula os instantes de publicação: um vídeo por dia corrido (inclui fins de semana
 * e feriados), sempre no horário local indicado. Soma dias de calendário no fuso
 * informado e devolve o instante em UTC.
 */
export function computeSchedule(startIsoDate: string, count: number, timezone: string, publishTime: string): Date[] {
  const { hour, minute } = parseTime(publishTime);
  const start = DateTime.fromISO(startIsoDate, { zone: timezone });
  if (!start.isValid) throw new Error(`Data inicial inválida: ${startIsoDate}`);
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    const local = start.plus({ days: i }).set({ hour, minute, second: 0, millisecond: 0 });
    out.push(local.toUTC().toJSDate());
  }
  return out;
}

export function formatLocal(date: Date | string, timezone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return DateTime.fromJSDate(d).setZone(timezone).toFormat('dd/MM/yyyy HH:mm');
}

export function todayIso(clock: Clock, timezone: string): string {
  return DateTime.fromJSDate(clock.now()).setZone(timezone).toISODate()!;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}
