import { spawn } from 'node:child_process';
import fs from 'node:fs';

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  videoCodec?: string;
  formatName: string;
  hasVideo: boolean;
}

export type Prober = (file: string) => Promise<ProbeResult>;

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e: any) => {
      clearTimeout(t);
      reject(e?.code === 'ENOENT' ? new Error(`"${cmd}" não encontrado. Instale o FFmpeg ou ajuste FFPROBE_PATH.`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${cmd} saiu com código ${code}`));
    });
  });
}

/** Lê duração, resolução (considerando rotação) e codec com o ffprobe. */
export function createFfprobe(ffprobePath: string): Prober {
  return async (file) => {
    const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    const data = JSON.parse(out);
    const v = (data.streams ?? []).find((s: any) => s.codec_type === 'video');
    let width = Number(v?.width ?? 0);
    let height = Number(v?.height ?? 0);
    const rotation = Math.abs(
      Number(v?.tags?.rotate ?? v?.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? 0),
    );
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
    return {
      durationSec: Number(data.format?.duration ?? v?.duration ?? 0),
      width,
      height,
      videoCodec: v?.codec_name,
      formatName: String(data.format?.format_name ?? ''),
      hasVideo: !!v,
    };
  };
}

/** Converte imagem para JPEG (o Instagram exige JPEG na capa). */
export async function toJpeg(ffmpegPath: string, input: string, output: string): Promise<void> {
  await run(ffmpegPath, ['-y', '-v', 'error', '-i', input, '-q:v', '3', output]);
}

/** Identifica o tipo real do arquivo pelos primeiros bytes (não confia na extensão). */
export function sniff(head: Buffer): { kind: 'video' | 'image'; mime: string; ext: string } | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  return null;
}

export async function fileSize(file: string): Promise<number> {
  return (await fs.promises.stat(file)).size;
}
