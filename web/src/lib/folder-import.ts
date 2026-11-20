// Importação por pasta: cada pasta tem um vídeo, uma imagem (capa) e um .txt
// com títulos/descrições por rede (formato "═══ YOUTUBE ═══", "═══ FACEBOOK ═══"...).
import type { Platform, PlatformTexts } from '../../../server/src/shared/types';

export interface ImportGroup {
  name: string;
  video: File;
  cover?: File;
  texts?: Partial<Record<Platform, Partial<PlatformTexts>>>;
  /** Conteúdo bruto do .txt (para reconhecer vídeos já postados por títulos alternativos). */
  rawText?: string;
}

const isVideo = (f: File) => /\.(mp4|mov)$/i.test(f.name) || /^video\//.test(f.type);
const isImage = (f: File) => /\.(jpe?g)$/i.test(f.name) || f.type === 'image/jpeg';
const isText = (f: File) => /\.txt$/i.test(f.name);

/** Lê os arquivos soltos e as pastas (inclusive subpastas) de um evento de soltar. */
export async function filesFromDrop(dt: DataTransfer): Promise<Array<{ file: File; dir: string }>> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.kind === 'file' ? (i as any).webkitGetAsEntry?.() : null))
    .filter(Boolean);
  if (!entries.length) return Array.from(dt.files).map((file) => ({ file, dir: '' }));
  const out: Array<{ file: File; dir: string }> = [];
  const walk = async (entry: any, dir: string): Promise<void> => {
    if (entry.isFile) {
      out.push({ file: await new Promise<File>((ok, fail) => entry.file(ok, fail)), dir });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      for (;;) {
        const batch: any[] = await new Promise((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const e of batch) await walk(e, path);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Arquivos de <input webkitdirectory>: usa o caminho relativo para agrupar. */
export function filesFromInput(list: FileList): Array<{ file: File; dir: string }> {
  return Array.from(list).map((file) => {
    const rel = (file as any).webkitRelativePath as string | undefined;
    return { file, dir: rel ? rel.split('/').slice(0, -1).join('/') : '' };
  });
}

/** Agrupa por pasta. Pasta com um único vídeo leva junto a capa e o txt. */
export async function buildGroups(files: Array<{ file: File; dir: string }>): Promise<ImportGroup[]> {
  const byDir = new Map<string, File[]>();
  for (const { file, dir } of files) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  const groups: ImportGroup[] = [];
  const dirs = [...byDir.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  for (const dir of dirs) {
    const list = byDir.get(dir)!;
    const videos = list.filter(isVideo).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    if (videos.length !== 1) {
      for (const video of videos) groups.push({ name: video.name, video });
      continue;
    }
    const txt = list.find(isText);
    const raw = txt ? await txt.text() : undefined;
    groups.push({
      name: dir.split('/').pop() || videos[0].name,
      video: videos[0],
      cover: list.find(isImage),
      texts: raw ? parseTexts(raw) : undefined,
      rawText: raw,
    });
  }
  return groups;
}

const SECTION: Array<[RegExp, Platform | 'other']> = [
  [/YOUTUBE/i, 'youtube'],
  [/FACEBOOK/i, 'facebook'],
  [/INSTAGRAM/i, 'instagram'],
  [/TIKTOK/i, 'tiktok'],
];

const clean = (lines: string[]) => lines.join('\n').replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');

/** Converte o divulgacao.txt em textos por rede. */
export function parseTexts(raw: string): Partial<Record<Platform, Partial<PlatformTexts>>> {
  const lines = raw.replace(/\r/g, '').split('\n');
  const sections: Partial<Record<Platform | 'other', string[]>> = {};
  let current: Platform | 'other' | null = null;
  const header: string[] = [];
  for (const line of lines) {
    if (/[═=]{3,}/.test(line)) {
      current = SECTION.find(([re]) => re.test(line))?.[1] ?? 'other';
      sections[current] = [];
      continue;
    }
    if (current) sections[current]!.push(line);
    else header.push(line);
  }
  const fileTitle = header.find((l) => l.trim())?.trim() ?? '';
  const out: Partial<Record<Platform, Partial<PlatformTexts>>> = {};

  const yt = sections.youtube;
  let ytTitle = fileTitle;
  if (yt) {
    const ti = yt.findIndex((l) => /^\s*T[ÍI]TULO\s*$/i.test(l));
    if (ti >= 0) ytTitle = yt.slice(ti + 1).find((l) => l.trim())?.trim() ?? ytTitle;
    const di = yt.findIndex((l) => /^\s*DESCRI[ÇC][ÃA]O\s*$/i.test(l));
    const end = yt.findIndex((l, i) => i > di && /^\s*TAGS\b/i.test(l));
    const desc = di >= 0 ? clean(yt.slice(di + 1, end > di ? end : undefined)) : clean(yt);
    out.youtube = { title: ytTitle.slice(0, 100), description: desc };
  }
  if (sections.facebook) out.facebook = { title: ytTitle || fileTitle, description: clean(sections.facebook) };
  if (sections.instagram) out.instagram = { description: clean(sections.instagram) };
  if (sections.tiktok) out.tiktok = { description: clean(sections.tiktok) };

  // Txt sem seções: primeira linha é o título, o resto vale para todas as redes.
  if (!Object.keys(out).length && fileTitle) {
    const body = clean(lines.slice(lines.findIndex((l) => l.trim()) + 1));
    out.youtube = { title: fileTitle.slice(0, 100), description: body };
    out.facebook = { title: fileTitle, description: body };
    out.instagram = { description: body || fileTitle };
    out.tiktok = { description: body || fileTitle };
  }
  return out;
}
