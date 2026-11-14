import { describe, expect, it } from 'vitest';
import { brToIso, isValidBrDate, maskBrDate, todayIsoSaoPaulo } from './date';

describe('campo de data DD/MM/AAAA', () => {
  it('aplica a máscara ao digitar', () => {
    expect(maskBrDate('1')).toBe('1');
    expect(maskBrDate('1511')).toBe('15/11');
    expect(maskBrDate('15112026')).toBe('15/11/2026');
    expect(maskBrDate('15/11/2026999')).toBe('15/11/2026');
  });
  it('valida datas reais', () => {
    expect(isValidBrDate('15/11/2026')).toBe(true);
    expect(isValidBrDate('31/11/2026')).toBe(false);
    expect(isValidBrDate('29/02/2027')).toBe(false);
    expect(brToIso('15/11/2026')).toBe('2026-11-15');
  });
  it('usa o dia de São Paulo, não o do navegador', () => {
    // 02:00 UTC de 16/11 ainda é 15/11 em São Paulo (UTC-3)
    expect(todayIsoSaoPaulo(new Date('2026-11-16T02:00:00Z'))).toBe('2026-11-15');
  });
});
