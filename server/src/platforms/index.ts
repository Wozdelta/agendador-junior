import type { AppContext } from '../context.js';
import type { AppMode, Platform } from '../shared/types.js';
import { DemoAdapter } from './demo.js';
import { FacebookAdapter } from './facebook.js';
import { InstagramAdapter } from './instagram.js';
import { TikTokAdapter } from './tiktok.js';
import type { PlatformAdapter } from './types.js';
import { YouTubeAdapter } from './youtube.js';

const cache = new WeakMap<AppContext, Map<string, PlatformAdapter>>();

/** Conectores reais e simulados ficam separados: o modo da tarefa decide qual usar. */
export function adapterFor(ctx: AppContext, mode: AppMode, platform: Platform): PlatformAdapter {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  const key = `${mode}:${platform}`;
  let a = m.get(key);
  if (!a) {
    if (mode === 'demo') a = new DemoAdapter(platform, ctx);
    else if (platform === 'youtube') a = new YouTubeAdapter(ctx);
    else if (platform === 'facebook') a = new FacebookAdapter(ctx);
    else if (platform === 'instagram') a = new InstagramAdapter(ctx);
    else a = new TikTokAdapter(ctx);
    m.set(key, a);
  }
  return a;
}
