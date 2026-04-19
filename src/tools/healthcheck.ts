import axios from 'axios';

type Status = 'ok' | 'start' | 'fail';

export async function healthcheckPing(status: Status): Promise<{ ok: true; status: Status }> {
  const uuid = process.env['HEALTHCHECK_UUID'];
  if (!uuid) {
    console.warn('[healthcheck] HEALTHCHECK_UUID not set — skipping ping');
    return { ok: true, status };
  }

  const suffix = status === 'ok' ? '' : `/${status}`;
  const url = `https://hc-ping.com/${uuid}${suffix}`;

  try {
    await axios.get(url, { timeout: 10_000 });
    console.log(`[healthcheck] ping "${status}" sent`);
  } catch (err) {
    console.error('[healthcheck] ping failed:', err);
    // Don't throw — a missed ping is bad but shouldn't crash the heartbeat
  }
  return { ok: true, status };
}

export const healthcheckTools = [
  {
    type: 'function' as const,
    function: {
      name: 'healthcheck_ping',
      description: 'Ping Healthchecks.io. Call with "start" at heartbeat begin and "ok" at end. Use "fail" on error.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'start', 'fail'] },
        },
        required: ['status'],
      },
    },
  },
];
