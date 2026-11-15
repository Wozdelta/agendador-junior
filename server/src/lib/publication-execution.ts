import type { AppContext } from '../context.js';
import type { Task } from '../domain/model.js';
import { hasPersistence } from './capabilities.js';
export function cloudPublicationQueue(ctx:AppContext) {
  return ctx.config.runtime==='vercel'&&ctx.config.publicationSchedulerEnabled&&hasPersistence(ctx);
}
export function executableInCloud(ctx:AppContext,t:Task) {
  if(t.mode!=='real')return false;
  if(['youtube','facebook'].includes(t.platform)&&t.remote.strategy==='native'&&!t.remote.queueFallback)return true;
  return cloudPublicationQueue(ctx)&&t.platform==='tiktok'&&['direct','inbox'].includes(t.remote.strategy);
}
