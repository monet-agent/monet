import fs from 'fs';
import path from 'path';
import { hasJournalEntries } from './journal.js';

const PUBLIC_LOG_PATH = () => path.join(process.env['DATA_DIR'] ?? '/data', 'memory/public_log.md');

export function publicLogAppend(text: string): { ok: true } {
  if (!hasJournalEntries()) {
    throw new Error(
      'public_log_append rejected: no journal_append call in this heartbeat. ' +
        'Some private thinking must precede public writing.',
    );
  }

  const ts = new Date().toISOString();
  const entry = `\n## ${ts}\n\n${text}\n\n---\n`;

  fs.appendFileSync(PUBLIC_LOG_PATH(), entry, 'utf8');
  return { ok: true };
}

export const publicLogTools = [
  {
    type: 'function' as const,
    function: {
      name: 'public_log_append',
      description:
        'Append to memory/public_log.md. Requires at least one journal_append call first this heartbeat.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Public log entry text (markdown supported).' },
        },
        required: ['text'],
      },
    },
  },
];
