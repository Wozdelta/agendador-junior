import { migrationRoutes } from './routes/migration.js';
import { analyticsRoutes, analyticsCron } from './routes/analytics.js';
import { publicationCron } from './routes/publication.js';
import { authRoutes, authenticate } from './routes/auth.js';
import { manualRoutes } from './routes/manual.js';
import { directPublicRoutes, directRoutes } from './routes/direct.js';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AppContext } from './context.js';
import { PROJECT_ROOT } from './config.js';
import { batchRoutes } from './routes/batches.js';
import { errorHandler, externalGuard, noStore, originGuard, prepareRequest } from './routes/middleware.js';
import { cloudRoutes } from './routes/cloud.js';
import { connectionRoutes, mediaRoutes, publicRoutes, settingsRoutes, taskRoutes, webDist } from './routes/other.js';

export function createApp(ctx: AppContext, authorize: express.RequestHandler = authenticate(ctx)): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(externalGuard(ctx));
  app.use(publicRoutes(ctx));

  const api = express.Router();
  api.use(noStore);
  api.use(originGuard(ctx));
  api.use(express.json({ limit: '1mb' }));
  api.use(authRoutes(ctx));
  api.use(analyticsCron(ctx));
  api.use(publicationCron(ctx));
  api.use(directPublicRoutes(ctx));
  api.use(authorize);
  api.use(manualRoutes(ctx));
  api.use(directRoutes(ctx));
  api.use(migrationRoutes(ctx));
  api.use(prepareRequest(ctx));
  api.use(cloudRoutes(ctx));
  api.get('/health', (_req, res) => {
    res.json({ ok: true, mode: ctx.settings.get().mode });
  });
  api.use(settingsRoutes(ctx));
  api.use(batchRoutes(ctx));
  api.use(taskRoutes(ctx));
  api.use(connectionRoutes(ctx));
  api.use(analyticsRoutes(ctx));
  api.use(mediaRoutes(ctx));
  api.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.', code: 'not_found' });
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
