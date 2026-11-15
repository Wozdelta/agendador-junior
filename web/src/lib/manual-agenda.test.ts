import { describe, expect, it } from 'vitest';
import { MANUAL_AGENDA_KEY, manualDates, markManualPlatform, readManualAgenda, saveManualAgenda, type ManualEntry } from './manual-agenda';

describe('agenda manual sem serviços', () => {
  it('gera cinco dias consecutivos, incluindo mudança de mês e ano bissexto', () => {
    expect(manualDates('2028-02-27', 5)).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']);
    expect(() => manualDates('2026-02-30', 1)).toThrow();
  });
  it('persiste e restaura registros e mantém status independente por plataforma', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const rows: ManualEntry[] = [{ id: 'test', date: '2026-12-10', title: 'Vídeo', description: 'Legenda', originalName: 'video.mp4', platforms: { youtube: false, tiktok: false } }];
    saveManualAgenda(storage, rows);
    const restored = readManualAgenda(storage);
    const completed = markManualPlatform(restored, 'test', 'youtube');
    saveManualAgenda(storage, completed);
    expect(readManualAgenda(storage)[0].platforms).toEqual({ youtube: true, tiktok: false });
    expect(rows[0].platforms.youtube).toBe(false);
    expect(markManualPlatform(completed, 'test', 'instagram')[0].platforms.instagram).toBeUndefined();
  });
  it('não sobrescreve registros inválidos nem disfarça falta de armazenamento', () => {
    const text = '{broken';
    const storage = { getItem: () => text, setItem: () => { throw new Error('Quota'); } };
    expect(() => readManualAgenda(storage)).toThrow();
    expect(storage.getItem()).toBe(text);
    expect(() => saveManualAgenda(storage, [])).toThrow('Quota');
    expect(readManualAgenda({ getItem: () => null, setItem: () => {} })).toEqual([]);
    expect(MANUAL_AGENDA_KEY).not.toContain('token');
  });
});
