import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { log } from './lib/log.js';
import { Worker } from './queue/worker.js';

async function main() {
  const config = loadConfig();
  const ctx = await createContext({ config });
  if (!ctx.vault.available) {
    log.warn('TOKEN_ENCRYPTION_KEY não definida: conexões reais ficam desativadas até você configurá-la.');
  }
  const worker = new Worker(ctx);
  await worker.recover();
  worker.start();
  const app = createApp(ctx);
  const server = app.listen(config.port, config.host, () => {
    log.info(`Backend em http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port} — modo ${ctx.settings.get().mode === 'demo' ? 'DEMONSTRAÇÃO' : 'REAL'}.`);
    log.info(`Fila ativa: verifica tarefas a cada ${config.workerTickMs / 1000}s (fuso ${config.timezone}).`);
  });
  server.requestTimeout = 0; // uploads grandes
  const shutdown = () => {
    log.info('Encerrando…');
    worker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Falha ao iniciar:', err?.stack ?? err);
  process.exit(1);
});
