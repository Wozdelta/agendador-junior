// Explicit setup only; never called by the build. Read secrets from environment.
import 'dotenv/config';
const { QSTASH_TOKEN, CRON_SECRET, APP_URL } = process.env;
if (!QSTASH_TOKEN || !CRON_SECRET || !APP_URL?.startsWith('https://')) {
  throw new Error('Preencha QSTASH_TOKEN, CRON_SECRET e APP_URL antes de configurar o acionamento.');
}
const response = await fetch(`https://qstash.upstash.io/v2/schedules/${APP_URL.replace(/\/$/, '')}/api/cron/tick`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${QSTASH_TOKEN}`,
    'Upstash-Schedule-Id': 'agendador-junior-tick',
    'Upstash-Cron': '* * * * *',
    'Upstash-Forward-Authorization': `Bearer ${CRON_SECRET}`,
    'Upstash-Retries': '3',
    'Content-Type': 'application/json',
  }, body: '{}',
});
if (!response.ok) throw new Error(`QStash HTTP ${response.status}. Verifique o painel e os limites do plano.`);
console.log('Acionamento recorrente configurado:', (await response.json()).scheduleId);
