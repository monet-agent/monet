import http from 'http';
import cron from 'node-cron';
import { runHeartbeat } from './heartbeat_loop.js';
import { ingestTelegramUpdate, type TgMessage } from './tools/telegram_bridge.js';

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.log('[main] previous heartbeat still running, skipping tick');
    return;
  }
  running = true;
  try {
    await runHeartbeat();
  } catch (err) {
    console.error('[main] heartbeat error:', err);
  } finally {
    running = false;
  }
}

// Telegram webhook — fires tick() immediately when a message arrives.
const WEBHOOK_SECRET = process.env['TELEGRAM_WEBHOOK_SECRET'] ?? '';
const WEBHOOK_PORT = 8088;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end();
    return;
  }

  // Validate secret token set during setWebhook registration.
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (!WEBHOOK_SECRET || token !== WEBHOOK_SECRET) {
    console.warn('[webhook] rejected request — bad or missing secret token');
    res.writeHead(401).end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.writeHead(200).end('ok');
    try {
      const update = JSON.parse(body) as TgMessage;
      const accepted = ingestTelegramUpdate(update);
      if (accepted) {
        tick().catch((e) => console.error('[webhook] tick error:', e));
      }
    } catch (e) {
      console.warn('[webhook] failed to parse update:', e);
    }
  });
});

server.listen(WEBHOOK_PORT, '0.0.0.0', () => {
  console.log(`[webhook] listening on 0.0.0.0:${WEBHOOK_PORT}`);
});

// Every 30 minutes
cron.schedule('*/30 * * * *', () => {
  tick().catch((e) => console.error('[main] unhandled tick error:', e));
});

console.log('[main] mon€t started — heartbeat scheduled every 30 minutes');
console.log('[main] first heartbeat in', 30 - (new Date().getMinutes() % 30), 'minutes');

// Run immediately on start so we don't wait up to 30 min for first heartbeat
tick().catch((e) => console.error('[main] initial tick error:', e));
