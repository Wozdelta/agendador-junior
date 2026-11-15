import type { IncomingMessage, ServerResponse } from 'node:http';

// Default Node handler: dynamic imports keep initialization failures inside the
// JSON boundary instead of Vercel's plain-text FUNCTION_INVOCATION_FAILED page.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const { loadConfig } = await import('../server/src/config.js');
    const config = loadConfig();
    if (config.runtime === 'vercel' && (config.storage !== 'redis' || config.mediaStorage !== 'blob' || !config.tokenKey || !config.cronSecret)) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Serviço ainda não configurado. Conecte Redis e Blob e defina TOKEN_ENCRYPTION_KEY e CRON_SECRET na Vercel.', code: 'service_not_configured' }));
      return;
    }
    const [{ createContext }, { createApp }] = await Promise.all([
      import('../server/src/context.js'), import('../server/src/app.js'),
    ]);
    // One context per request avoids shared mutable mode/snapshots under Fluid concurrency.
    const ctx = await createContext({ config });
    const url = new URL(req.url ?? '/', 'https://internal');
    const route = url.searchParams.get('__path');
    if (route !== null) {
      if (!/^[\w/.-]*$/.test(route) || route.includes('..')) throw new Error('Invalid route');
      url.searchParams.delete('__path');
      req.url = `/api/${route}${url.search ? url.search : ''}`;
    }
    const app = createApp(ctx);
    await new Promise<void>(resolve => {
      res.once('finish', resolve);
      res.once('close', resolve);
      app(req, res);
    });
  } catch (err) {
    console.error('API initialization failed', err instanceof Error ? err.message : 'unknown');
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Serviço indisponível. Tente de novo em instantes.', code: 'service_unavailable' }));
  }
}
