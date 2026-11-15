import { PLATFORMS, type Platform, type PlatformTexts } from './types.js';

export type PublicationTexts = Record<Platform, PlatformTexts>;
/** Legacy text is seeded once. Versioned records may intentionally contain empty fields. */
export function publicationTexts(value: { textVersion?: number; texts?: Partial<PublicationTexts>; title?: string; description?: string }): PublicationTexts {
  return Object.fromEntries(PLATFORMS.map(p => {
    const old = value.texts?.[p];
    const seed = value.textVersion !== 2;
    return [p, { ...old, enabled: old?.enabled ?? true,
      title: p === 'facebook' || p === 'youtube' ? (old?.title || (seed ? value.title : '') || '') : '',
      description: old?.description || (seed ? value.description : '') || '',
    }];
  })) as PublicationTexts;
}

export function mergePublicationTexts(current: PublicationTexts, patch: Partial<PublicationTexts>): PublicationTexts {
  return Object.fromEntries(PLATFORMS.map(p => [p, { ...current[p], ...patch[p] }])) as PublicationTexts;
}
