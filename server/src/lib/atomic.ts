import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Grava JSON de forma atômica: arquivo temporário + fsync + rename. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // No Windows o rename pode falhar momentaneamente (antivírus/indexador): tenta de novo.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err: any) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw new Error(`Não foi possível ler ${path.basename(file)}: ${err.message}`);
  }
}
