import fs from 'fs';
import path from 'path';

const WORKSPACE_ROOT = () => path.join(process.env['DATA_DIR'] ?? '/data', 'workspace');
const MAX_WRITE_BYTES = 512 * 1024; // 512 KB per write
const MAX_READ_BYTES = 512 * 1024;

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
