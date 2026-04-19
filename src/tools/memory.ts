// memory_update — the one sanctioned way for monet to rewrite /data/MEMORY.md.
//
// MEMORY.md is the single file that crosses the wake gap between heartbeats.
// The soul files otherwise ship via deploy and are not runtime-editable.
// monet has been trying workspace_write("MEMORY.md") and silently writing
// into workspace/MEMORY.md — this tool closes that gap.

import fs from 'fs';
import path from 'path';

const MEMORY_PATH = () => path.join(process.env['DATA_DIR'] ?? '/data', 'MEMORY.md');
const MAX_MEMORY_BYTES = 128 * 1024; // 128 KB — MEMORY.md must stay tight.

export function memoryUpdate(content: string): { ok: true; bytes: number } {
  if (typeof content !== 'string') throw new Error('memory_update: content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) throw new Error('memory_update: refusing to clobber MEMORY.md with empty content');
  if (bytes > MAX_MEMORY_BYTES) {
    throw new Error(
      `memory_update: content is ${bytes} bytes, max ${MAX_MEMORY_BYTES}. MEMORY.md is distilled long-term memory — summarize, don't accumulate.`,
    );
  }
  const target = MEMORY_PATH();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
  return { ok: true, bytes };
}

export const memoryTools = [
  {
    type: 'function' as const,
    function: {
      name: 'memory_update',
      description:
        'Atomically rewrite /data/MEMORY.md — the one file that crosses the wake gap between heartbeats. Always provide the FULL new file content (not a diff). Max 128KB. Use at end of heartbeat to persist: current state snapshot, W0.1 pipeline moves, last-sent timestamps, infra state, lessons learned. Do NOT try to edit MEMORY.md via workspace_write — that writes to workspace/ and is lost next wake.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The full new contents of MEMORY.md.' },
        },
        required: ['content'],
      },
    },
  },
];
