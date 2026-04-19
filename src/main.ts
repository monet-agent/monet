import cron from 'node-cron';
import { runHeartbeat } from './heartbeat_loop.js';

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

// Every 30 minutes
cron.schedule('*/30 * * * *', () => {
  tick().catch((e) => console.error('[main] unhandled tick error:', e));
});

console.log('[main] mon€t started — heartbeat scheduled every 30 minutes');
console.log('[main] first heartbeat in', 30 - (new Date().getMinutes() % 30), 'minutes');

// Run immediately on start so we don't wait up to 30 min for first heartbeat
tick().catch((e) => console.error('[main] initial tick error:', e));
