import express from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
const config = loadConfig();
const app = express();
// Mesmo isolamento por requisi??o usado na Function da Vercel; sem timer local.
app.use(async (req, res, next) => {
  try {
    const ctx = await createContext({ config, lazy: true });
    createApp(ctx)(req, res, next);
  } catch {
    res
      .status(503)
      .json({
        error: 'Servi?o indispon?vel. Confira a configura??o.',
        code: 'service_unavailable',
      });
  }
});
app.listen(config.port, config.host, () =>
  console.log(`Agendador em http://localhost:${config.port}`),
);
