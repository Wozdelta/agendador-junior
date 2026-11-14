import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AppContext } from './context.js';
import { PROJECT_ROOT } from './config.js';
import { authRoutes, directRoutes } from './routes/access.js';
import { batchRoutes } from './routes/batches.js';
import { directCors, errorHandler, externalGuard, noStore, originGuard, sessionGuard } from './routes/middleware.js';
import { connectionRoutes, mediaRoutes, publicRoutes, settingsRoutes, taskRoutes, webDist } from './routes/other.js';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(externalGuard(ctx));
  app.use(publicRoutes(ctx));
  // Upload e mídia por link assinado, direto no backend (sem passar pela Vercel).
  app.use('/direct', directCors(ctx));
  app.use(directRoutes(ctx));

  const api = express.Router();
  api.use(noStore);
  api.use(originGuard(ctx));
  api.use(sessionGuard(ctx));
  api.use(express.json({ limit: '1mb' }));
  api.get('/health', (_req, res) => {
    res.json({ ok: true, mode: ctx.settings.get().mode });
  });
  api.use(authRoutes(ctx));
  api.use(settingsRoutes(ctx));
  api.use(batchRoutes(ctx));
  api.use(taskRoutes(ctx));
  api.use(connectionRoutes(ctx));
  api.use(mediaRoutes(ctx));
  api.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });
  app.use('/api', api);

  // Uso local em produção: a interface compilada é servida pelo mesmo processo.
  const dist = webDist(PROJECT_ROOT);
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: 'index.html' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
