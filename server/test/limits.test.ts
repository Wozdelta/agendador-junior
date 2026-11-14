import { describe, expect, it } from 'vitest';
import { countText, validatePlatform } from '../src/shared/limits.js';

const media = { id: 'm', kind: 'video' as const, originalName: 'a.mp4', mime: 'video/mp4', size: 1000, durationSec: 30, width: 1080, height: 1920 };

describe('limites por plataforma', () => {
  it('conta caracteres, runas UTF-16 e bytes', () => {
    expect(countText('ação 😀', 'codepoints')).toBe(6);
    expect(countText('ação 😀', 'utf16')).toBe(7);
    expect(countText('ação 😀', 'utf8bytes')).toBe(11);
  });

  it('YouTube exige título, escolha de público infantil e formato vertical/quadrado até 3 min', () => {
    const base = { enabled: true, title: 'ok', description: '', madeForKids: false };
    expect(validatePlatform('youtube', base, media).filter((i) => i.level === 'error')).toEqual([]);
    expect(validatePlatform('youtube', { ...base, madeForKids: null }, media).some((i) => i.field === 'madeForKids')).toBe(true);
    expect(validatePlatform('youtube', { ...base, title: 'x'.repeat(101) }, media).some((i) => i.field === 'title')).toBe(true);
    expect(validatePlatform('youtube', { ...base, description: 'a<b' }, media).some((i) => i.level === 'error')).toBe(true);
    expect(validatePlatform('youtube', base, { ...media, width: 1920, height: 1080 }).some((i) => i.level === 'error')).toBe(true);
    expect(validatePlatform('youtube', base, { ...media, durationSec: 181 }).some((i) => i.level === 'error')).toBe(true);
  });

  it('Instagram: 2.200 caracteres, 30 hashtags, 20 menções', () => {
    const ok = { enabled: true, title: '', description: 'a'.repeat(2200) };
    expect(validatePlatform('instagram', ok, media).filter((i) => i.level === 'error')).toEqual([]);
    expect(validatePlatform('instagram', { ...ok, description: 'a'.repeat(2201) }, media).some((i) => i.level === 'error')).toBe(true);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect(validatePlatform('instagram', { ...ok, description: tags }, media).some((i) => /hashtags/.test(i.message))).toBe(true);
  });

  it('Facebook Reels: 3 a 90 segundos', () => {
    const t = { enabled: true, title: '', description: '' };
    expect(validatePlatform('facebook', t, { ...media, durationSec: 91 }).some((i) => i.level === 'error')).toBe(true);
    expect(validatePlatform('facebook', t, { ...media, durationSec: 2 }).some((i) => i.level === 'error')).toBe(true);
  });
});
