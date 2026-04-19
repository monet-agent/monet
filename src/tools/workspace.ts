import fs from 'fs';
import path from 'path';

const WORKSPACE_ROOT = () => path.join(process.env['DATA_DIR'] ?? '/data', 'workspace');
const MAX_WRITE_BYTES = 512 * 1024; // 512 KB per write
const MAX_READ_BYTES = 512 * 1024;

// Soul files and live state files that are NOT in workspace/. Monet keeps
// trying to read/write these through the workspace tools and getting
// confusing "not found" errors. Redirect explicitly so the mental model
// gets corrected on the first wrong call.
const SOUL_FILES_AT_DATA_ROOT = new Set([
  'SOUL.md', 'IDENTITY.md', 'HEARTBEAT.md', 'TOOLS.md', 'PLAYBOOK.md',
  'MEMORY.md', 'DECISIONS.md', 'RELATIONSHIPS.md', 'ROSTER.md',
  'COMMITMENTS.md', 'LEDGER.md', 'SECURITY.md', 'AGENTS.md', 'USER.md',
  'CONTACTS.md', 'DEPLOY.md',
]);
const LIVE_STATE_PATHS: Record<string, string> = {
  'memory/inbox.md': 'already auto-loaded in your system context on every heartbeat. To reply to a message, call imsg_send. To clear handled items, call inbox_rewrite.',
  'memory/journal.md': 'past journal entries are cryptographically sealed and unreadable by design. Use journal_read_current_session to see THIS heartbeat\'s buffer.',
  'memory/journal.md.age': 'journal is encrypted and cannot be decrypted by you. Do not attempt to read it.',
  'memory/public_log.md': 'public_log is append-only. To add an entry call public_log_append. It is not readable via workspace.',
  'ledger.jsonl': 'ledger is hash-chained and append-only. To read summarized state check MEMORY.md. To append call ledger_append.',
};

function resolveInsideWorkspace(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('workspace path must be a non-empty string');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error('workspace path must be relative');
  }
  if (relativePath.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('workspace path may not contain ".." segments');
  }
  // Helpful redirects for the common mental-model mistakes.
  const normalized = relativePath.replace(/^\.?\//, '');
  if (SOUL_FILES_AT_DATA_ROOT.has(normalized)) {
    throw new Error(
      `${normalized} is a soul file at /data/${normalized}, NOT in workspace/. ` +
      `It is already loaded into your system context at the top of every heartbeat — just scroll up. ` +
      `To UPDATE MEMORY.md specifically, call memory_update(content). Other soul files ship via deploy and cannot be edited in-heartbeat.`,
    );
  }
  if (normalized in LIVE_STATE_PATHS) {
    throw new Error(`${normalized}: ${LIVE_STATE_PATHS[normalized]}`);
  }
  const root = WORKSPACE_ROOT();
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('workspace path resolves outside workspace/');
  }
  return resolved;
}

export function workspaceWrite(
  relativePath: string,
  content: string,
): { ok: true; path: string; bytes: number } {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes (got ${bytes})`);
  }
  const target = resolveInsideWorkspace(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { ok: true, path: path.relative(WORKSPACE_ROOT(), target), bytes };
}

export function workspaceRead(relativePath: string): { path: string; content: string } {
  const target = resolveInsideWorkspace(relativePath);
  if (!fs.existsSync(target)) throw new Error(`workspace file not found: ${relativePath}`);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error(`${relativePath} is a directory; use workspace_list`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`file exceeds ${MAX_READ_BYTES} bytes (got ${stat.size})`);
  }
  return { path: relativePath, content: fs.readFileSync(target, 'utf8') };
}

export function workspaceList(relativePath: string = '.'): {
  path: string;
  entries: Array<{ name: string; type: 'file' | 'dir'; bytes?: number }>;
} {
  const target = resolveInsideWorkspace(relativePath);
  if (!fs.existsSync(target)) return { path: relativePath, entries: [] };
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error(`${relativePath} is not a directory`);
  const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => {
    if (d.isDirectory()) return { name: d.name, type: 'dir' as const };
    const s = fs.statSync(path.join(target, d.name));
    return { name: d.name, type: 'file' as const, bytes: s.size };
  });
  return { path: relativePath, entries };
}

export const workspaceTools = [
  {
    type: 'function' as const,
    function: {
      name: 'workspace_write',
      description:
        'Write a file into workspace/ (drafts, guides, skill source). Use for guides/<name>.md, skills/<name>/SKILL.md, scratch/<name>.md. Max 512KB per write. Paths must be relative and inside workspace/.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside workspace/, e.g. "guides/x402-helper.md".',
          },
          content: { type: 'string', description: 'File contents (markdown, code, etc.).' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'workspace_read',
      description: 'Read a file from workspace/. Relative path required.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside workspace/.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'workspace_list',
      description:
        'List entries in a workspace/ directory. Default lists workspace root. Use to survey existing drafts before writing.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory inside workspace/. Defaults to ".".',
          },
        },
      },
    },
  },
];
