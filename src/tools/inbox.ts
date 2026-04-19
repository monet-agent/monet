// Inbox = the one file Damian can write to reach monet inside a
// heartbeat. Monet reads it at boot (see heartbeat_loop.loadSoulContext)
// and should rewrite it to remove items it has addressed.

import fs from 'fs';
import path from 'path';

const INBOX_PATH = (): string =>
  path.join(process.env['DATA_DIR'] ?? '/data', 'memory/inbox.md');

const MAX_BYTES = 256 * 1024;

export function inboxRewrite(content: string): { ok: true; bytes: number } {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`inbox content exceeds ${MAX_BYTES} bytes`);
  const p = INBOX_PATH();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return { ok: true, bytes };
}

export const inboxTools = [
  {
    type: 'function' as const,
    function: {
      name: 'inbox_rewrite',
      description:
        'Rewrite memory/inbox.md. Use after addressing an instruction from Damian — remove the handled item(s) so you do not repeat work next heartbeat. Preserve any still-pending entries verbatim. Pass the full new file contents.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Full new inbox file content.' },
        },
        required: ['content'],
      },
    },
  },
];
