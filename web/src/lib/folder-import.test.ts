import { describe, expect, it } from 'vitest';
import { parseTexts } from './folder-import';

const TXT = `E SE EU FOSSE O ÚNICO HUMANO DO MUNDO?
Duração: 2:01

═══════════════ YOUTUBE (Shorts) ═══════════════

TÍTULO
E SE EU FOSSE O ÚNICO HUMANO DO MUNDO? 🌍

Outras opções:
- OUTRO

DESCRIÇÃO
Linha 1.

#shorts

TAGS (campo "Tags" do YouTube)
a, b

═══════════════ FACEBOOK (vídeo) ═══════════════

Texto do Facebook

═══════════════ INSTAGRAM (Reels) ═══════════════

Texto do Insta

═══════════════ TIKTOK ═══════════════

texto tiktok

═══════════════ SÉRIE / PRÓXIMA PARTE ═══════════════
Parte 1`;

describe('parseTexts', () => {
  it('separa título e descrição por rede', () => {
    const t = parseTexts(TXT);
    expect(t.youtube).toEqual({ title: 'E SE EU FOSSE O ÚNICO HUMANO DO MUNDO? 🌍', description: 'Linha 1.\n\n#shorts' });
    expect(t.facebook).toEqual({ title: 'E SE EU FOSSE O ÚNICO HUMANO DO MUNDO? 🌍', description: 'Texto do Facebook' });
    expect(t.instagram).toEqual({ description: 'Texto do Insta' });
    expect(t.tiktok).toEqual({ description: 'texto tiktok' });
  });
  it('txt simples: primeira linha é o título', () => {
    expect(parseTexts('Meu título\n\nCorpo').youtube).toEqual({ title: 'Meu título', description: 'Corpo' });
  });
});
