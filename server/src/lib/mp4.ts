// Leitura de metadados de MP4/MOV (ISO BMFF) e de imagens JPEG/PNG em JS puro.
// Usado na Vercel, onde não há ffprobe. Lê só cabeçalhos por intervalos de bytes
// (funciona com o "moov" no início ou no fim do arquivo).
import type { ProbeResult } from './media.js';

export type RangeReader = (offset: number, length: number) => Promise<Buffer>;

const MAX_MOOV = 64 * 1024 * 1024;

interface Box {
  type: string;
  start: number; // início do conteúdo (após o cabeçalho)
  end: number;
}

function children(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header || p + size > to) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}
const child = (buf: Buffer, b: Box, type: string) => children(buf, b.start, b.end).find((c) => c.type === type);

const fixed = (buf: Buffer, at: number) => buf.readInt32BE(at) / 65536;

export async function probeMp4(read: RangeReader, size: number): Promise<ProbeResult> {
  // 1) percorre as caixas de nível superior até achar ftyp e moov
  let p = 0;
  let brand = '';
  let moov: Buffer | null = null;
  let moovHeader = 8;
  while (p + 8 <= size) {
    const h = await read(p, Math.min(16, size - p));
    if (h.length < 8) throw new Error('Cabeçalho incompleto.');
    let boxSize = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (boxSize === 1) boxSize = Number(h.readBigUInt64BE(8));
    else if (boxSize === 0) boxSize = size - p;
    if (!Number.isSafeInteger(boxSize) || boxSize < 8 || p + boxSize > size) throw new Error('Arquivo MP4/MOV corrompido.');
    if (type === 'ftyp') brand = (await read(p + 8, 4)).toString('latin1');
    if (type === 'moov') {
      if (boxSize > MAX_MOOV) throw new Error('Cabeçalho do vídeo grande demais.');
      moov = await read(p, boxSize);
      moovHeader = h.readUInt32BE(0) === 1 ? 16 : 8;
      break;
    }
    p += boxSize;
  }
  if (!moov) throw new Error('Vídeo sem cabeçalho "moov" (arquivo incompleto ou não é MP4/MOV).');
  const root: Box = { type: 'moov', start: moovHeader, end: moov.length };

  // 2) duração global (mvhd)
  let durationSec = 0;
  const mvhd = child(moov, root, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.start];
    const timescale = v === 1 ? moov.readUInt32BE(mvhd.start + 20) : moov.readUInt32BE(mvhd.start + 12);
    const dur = v === 1 ? Number(moov.readBigUInt64BE(mvhd.start + 24)) : moov.readUInt32BE(mvhd.start + 16);
    if (timescale) durationSec = dur / timescale;
  }

  // 3) faixa de vídeo: dimensões, rotação e codec
  let width = 0;
  let height = 0;
  let codec: string | undefined;
  let hasVideo = false;
  for (const trak of children(moov, root.start, root.end).filter((b) => b.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    hasVideo = true;
    const tkhd = child(moov, trak, 'tkhd');
    if (tkhd) {
      const v = moov[tkhd.start];
      const matrix = tkhd.start + (v === 1 ? 52 : 40);
      const a = fixed(moov, matrix);
      const b = fixed(moov, matrix + 4);
      width = Math.round(fixed(moov, matrix + 36));
      height = Math.round(fixed(moov, matrix + 40));
      // matriz de rotação 90°/270°: a≈0 e |b|≈1 -> troca largura e altura
      if (Math.abs(a) < 0.5 && Math.abs(b) > 0.5) [width, height] = [height, width];
    }
    const stsd = (() => {
      const minf = mdia && child(moov, mdia, 'minf');
      const stbl = minf && child(moov, minf, 'stbl');
      return stbl && child(moov, stbl, 'stsd');
    })();
    if (stsd) {
      const fourcc = moov.toString('latin1', stsd.start + 12, stsd.start + 16);
      codec = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', mp4v: 'mpeg4', av01: 'av1', vp09: 'vp9' }[fourcc] ?? fourcc.trim();
    }
    break;
  }
  return { durationSec, width, height, videoCodec: codec, formatName: brand === 'qt  ' ? 'mov' : 'mp4', hasVideo };
}

/** Largura e altura de JPEG/PNG a partir dos primeiros bytes. */
export async function probeImage(read: RangeReader, size: number): Promise<{ width: number; height: number }> {
  const head = await read(0, Math.min(size, 256 * 1024));
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    let p = 2;
    while (p + 9 < head.length) {
      if (head[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = head[p + 1];
      const len = head.readUInt16BE(p + 2);
      // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: head.readUInt16BE(p + 5), width: head.readUInt16BE(p + 7) };
      }
      p += 2 + len;
    }
  }
  throw new Error('Não foi possível ler as dimensões da imagem.');
}
