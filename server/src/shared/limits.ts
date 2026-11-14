// Limites por plataforma, conferidos na documentação oficial em 14/11/2026.
// Fontes e versões estão listadas no README (seção "Referências consultadas").
import type { Issue, MediaInfo, Platform, PlatformTexts } from './types.js';

export type CountMode = 'codepoints' | 'utf16' | 'utf8bytes';

export interface FieldLimit {
  max: number;
  count: CountMode;
  required?: boolean;
  source: string;
}

export interface PlatformRules {
  title?: FieldLimit;
  description: FieldLimit;
  minDurationSec?: number;
  maxDurationSec?: number;
  maxBytes?: number;
  requireVerticalOrSquare?: boolean;
  recommendVertical?: boolean;
  maxHashtags?: number;
  maxMentions?: number;
  forbiddenChars?: string[];
}

export const RULES: Record<Platform, PlatformRules> = {
  youtube: {
    // YouTube Data API v3 — recurso videos: snippet.title até 100 caracteres,
    // snippet.description até 5000 bytes; "<" e ">" não são aceitos.
    title: { max: 100, count: 'codepoints', required: true, source: 'YouTube Data API v3 · videos#snippet.title' },
    description: { max: 5000, count: 'utf8bytes', source: 'YouTube Data API v3 · videos#snippet.description' },
    forbiddenChars: ['<', '>'],
    // Shorts: vídeos quadrados ou verticais de até 3 minutos (canais padrão, desde 15/10/2024).
    maxDurationSec: 180,
    requireVerticalOrSquare: true,
  },
  facebook: {
    // Reels Publishing API (Graph v27.0): title e description são UTF-8 sem limite publicado.
    // Usamos limites conservadores: 255 no título e 63.206 (limite de texto de publicação do Facebook).
    title: { max: 255, count: 'codepoints', source: 'Reels Publishing API (sem limite publicado; valor conservador)' },
    description: { max: 63206, count: 'codepoints', source: 'Limite de texto de publicação do Facebook' },
    // Especificação de Reels: 3 a 90 segundos, 9:16, mínimo 540x960.
    minDurationSec: 3,
    maxDurationSec: 90,
    recommendVertical: true,
  },
  instagram: {
    // IG User Media: legenda até 2.200 caracteres, 30 hashtags e 20 @menções.
    description: { max: 2200, count: 'codepoints', source: 'Instagram Graph API · IG User Media (caption)' },
    maxHashtags: 30,
    maxMentions: 20,
    // Reels: 3 s a 15 min, até 300 MB, MOV ou MP4.
    minDurationSec: 3,
    maxDurationSec: 15 * 60,
    maxBytes: 300 * 1024 * 1024,
    recommendVertical: true,
  },
  tiktok: {
    // Content Posting API: post_info.title até 2.200 em runas UTF-16.
    description: { max: 2200, count: 'utf16', source: 'TikTok Content Posting API · post_info.title' },
    // Todo criador pode publicar até 3 min; alguns até 10 min. Até 4 GB.
    maxDurationSec: 10 * 60,
    maxBytes: 4 * 1024 * 1024 * 1024,
    recommendVertical: true,
  },
};

export function countText(text: string, mode: CountMode): number {
  if (mode === 'utf16') return text.length;
  if (mode === 'utf8bytes') return new TextEncoder().encode(text).length;
  return Array.from(text).length;
}

export function countHashtags(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}
export function countMentions(text: string): number {
  return (text.match(/(^|\s)@[\w.]+/gu) ?? []).length;
}

const PLATFORM_NAME: Record<Platform, string> = {
  facebook: 'Facebook',
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

/** Valida textos e mídia de um vídeo para uma plataforma. Usado no servidor e na interface. */
export function validatePlatform(
  platform: Platform,
  texts: PlatformTexts,
  media: MediaInfo | undefined,
  itemId?: string,
): Issue[] {
  const rules = RULES[platform];
  const issues: Issue[] = [];
  const name = PLATFORM_NAME[platform];
  const push = (level: Issue['level'], message: string, field?: string) =>
    issues.push({ level, platform, itemId, field, message: `${name}: ${message}` });

  if (rules.title) {
    const n = countText(texts.title ?? '', rules.title.count);
    if (rules.title.required && !texts.title?.trim()) push('error', 'informe o título.', 'title');
    if (n > rules.title.max) push('error', `o título passou do limite (${n}/${rules.title.max}).`, 'title');
  }
  const d = countText(texts.description ?? '', rules.description.count);
  if (d > rules.description.max) {
    const unit = rules.description.count === 'utf8bytes' ? ' bytes' : '';
    push('error', `a descrição passou do limite (${d}/${rules.description.max}${unit}).`, 'description');
  }
  if (rules.forbiddenChars) {
    for (const ch of rules.forbiddenChars) {
      if ((texts.title ?? '').includes(ch) || (texts.description ?? '').includes(ch)) {
        push('error', `o caractere "${ch}" não é aceito no título nem na descrição.`, 'description');
      }
    }
  }
  if (rules.maxHashtags && countHashtags(texts.description ?? '') > rules.maxHashtags) {
    push('error', `use no máximo ${rules.maxHashtags} hashtags.`, 'description');
  }
  if (rules.maxMentions && countMentions(texts.description ?? '') > rules.maxMentions) {
    push('error', `use no máximo ${rules.maxMentions} menções (@).`, 'description');
  }
  if (platform === 'youtube' && (texts.madeForKids === null || texts.madeForKids === undefined)) {
    push('error', 'escolha se o vídeo é ou não "feito para crianças".', 'madeForKids');
  }
  if (platform === 'tiktok' && !texts.description?.trim()) {
    push('warning', 'a descrição está vazia.', 'description');
  }

  if (media) {
    const dur = media.durationSec ?? 0;
    if (rules.minDurationSec && dur < rules.minDurationSec) {
      push('error', `o vídeo precisa ter pelo menos ${rules.minDurationSec} s (tem ${dur.toFixed(1)} s).`);
    }
    if (rules.maxDurationSec && dur > rules.maxDurationSec) {
      push('error', `o vídeo passa do limite de ${formatDuration(rules.maxDurationSec)} (tem ${formatDuration(dur)}).`);
    }
    if (platform === 'tiktok' && dur > 180) {
      push('warning', 'vídeos acima de 3 min só são aceitos em contas com esse recurso liberado.');
    }
    if (rules.maxBytes && media.size > rules.maxBytes) {
      push('error', `o arquivo passa do limite de ${Math.round(rules.maxBytes / 1024 / 1024)} MB.`);
    }
    if (media.width && media.height) {
      if (rules.requireVerticalOrSquare && media.width > media.height) {
        push('error', `Shorts precisam ser verticais ou quadrados (o vídeo é ${media.width}x${media.height}).`);
      } else if (rules.recommendVertical && Math.abs(media.width / media.height - 9 / 16) > 0.02) {
        push('warning', `o formato recomendado é 9:16 (o vídeo é ${media.width}x${media.height}).`);
      }
      if (platform === 'facebook' && (Math.min(media.width, media.height) < 540)) {
        push('warning', 'a resolução mínima recomendada para Reels é 540x960.');
      }
    }
  }
  return issues;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}
