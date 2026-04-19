// Sandboxed executor for installed skills. Always-available (no tier gate).
//
// The Docker sandbox this agent runs in is already network=none and
// read-only root with tmpfs scratch. Spawning a subprocess inherits
// that isolation — no outbound traffic, no host FS access beyond the
// skill directory and workspace/scratch. That is the baseline.
//
// Tier 1 is local subprocess. Tier 3+ should migrate to e2b-dev or
// firecracker microVMs for per-run ephemeral sandboxes — flagged in
// the DECISIONS.md roadmap but not required at Tier 1.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const DATA_DIR = () => process.env['DATA_DIR'] ?? '/data';
const INSTALL_ROOT = () => path.join(DATA_DIR(), 'installed_skills');
const LEDGER_STATE = () => path.join(DATA_DIR(), 'memory/ledger_state.json');
const SCRATCH_ROOT = () => path.join(DATA_DIR(), 'workspace/scratch');

// Lowered to 0 on 2026-04-19 — monet can't earn its way to Tier 1 without
// the ability to actually run and test skills. The sandbox (spawn + no
// network + no secrets + timeout + size caps) is the real safety boundary,
// not the tier gate. E2B remote sandbox (see sandbox_exec) is the real
// capability upgrade for anything with deps.
const MIN_TIER = 0;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STDIO_BYTES = 64 * 1024;

const ALLOWED_RUNTIMES: Record<string, { bin: string; argPrefix: string[] }> = {
  node: { bin: 'node', argPrefix: [] },
  python: { bin: 'python3', argPrefix: [] },
  bash: { bin: 'bash', argPrefix: [] },
};

function currentTier(): number {
  try {
    if (!fs.existsSync(LEDGER_STATE())) return 0;
    const s = JSON.parse(fs.readFileSync(LEDGER_STATE(), 'utf8')) as { tier?: number };
    return Math.max(0, Math.floor(s.tier ?? 0));
  } catch {
    return 0;
  }
}

function resolveInstallDir(installDirName: string): string {
  if (installDirName.includes('..') || installDirName.includes('/') || installDirName.includes('\\')) {
    throw new Error('install_dir must be a bare directory name inside installed_skills/');
  }
  const full = path.join(INSTALL_ROOT(), installDirName);
  const rel = path.relative(INSTALL_ROOT(), full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('install_dir resolves outside installed_skills/');
  }
  if (!fs.existsSync(full)) throw new Error(`skill not installed: ${installDirName}`);
  if (!fs.existsSync(path.join(full, '.monet_install.json'))) {
    throw new Error(`${installDirName} is missing .monet_install.json — not a monet-installed skill`);
  }
  return full;
}

function resolveEntryPoint(installDir: string, entry: string): string {
  if (path.isAbsolute(entry)) throw new Error('entry must be relative');
  if (entry.split(/[\\/]/).some((s) => s === '..')) throw new Error('entry may not contain ".."');
  const full = path.resolve(installDir, entry);
  const rel = path.relative(installDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('entry resolves outside the install dir');
  }
  if (!fs.existsSync(full)) throw new Error(`entry file not found: ${entry}`);
  return full;
}

function truncate(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.byteLength <= MAX_STDIO_BYTES) return { text: buf.toString('utf8'), truncated: false };
  return {
    text: buf.subarray(0, MAX_STDIO_BYTES).toString('utf8') + '\n\n[truncated]',
    truncated: true,
  };
}

export interface SkillRunResult {
  ok: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  runtime: string;
  entry: string;
  install_dir: string;
}

export async function skillRun(
  installDir: string,
  runtime: string,
  entry: string,
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  stdin: string = '',
): Promise<SkillRunResult> {
  const tier = currentTier();
  if (tier < MIN_TIER) {
    throw new Error(`skill_run tier check failed (current: ${tier}, min: ${MIN_TIER}).`);
  }

  const rt = ALLOWED_RUNTIMES[runtime];
  if (!rt) throw new Error(`runtime must be one of: ${Object.keys(ALLOWED_RUNTIMES).join(', ')}`);

  const timeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs)));

  const resolvedInstallDir = resolveInstallDir(installDir);
  const resolvedEntry = resolveEntryPoint(resolvedInstallDir, entry);

  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('args must be an array of strings');
  }
  if (args.length > 32) throw new Error('too many args (max 32)');

  fs.mkdirSync(SCRATCH_ROOT(), { recursive: true });

  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: SCRATCH_ROOT(),
    TMPDIR: SCRATCH_ROOT(),
    LANG: 'C.UTF-8',
    // Deliberately do NOT pass KIMI_*, GITHUB_TOKEN, MOLTBOOK_API_KEY,
    // R2_*, COINBASE_AGENTKIT_KEY, etc. Skills run with zero secrets.
  };

  const start = Date.now();

  const result = await new Promise<SkillRunResult>((resolve) => {
    const child = spawn(rt.bin, [...rt.argPrefix, resolvedEntry, ...args], {
      cwd: resolvedInstallDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached=false so SIGTERM on parent propagates to child
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on('data', (c: Buffer) => {
      stdoutBytes += c.byteLength;
      if (stdoutBytes <= MAX_STDIO_BYTES * 2) stdoutChunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrBytes += c.byteLength;
      if (stderrBytes <= MAX_STDIO_BYTES * 2) stderrChunks.push(c);
    });

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const out = truncate(Buffer.concat(stdoutChunks));
      const err = truncate(Buffer.concat(stderrChunks));
      resolve({
        ok: code === 0 && !timedOut,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - start,
        stdout: out.text,
        stderr: err.text,
        stdout_truncated: out.truncated,
        stderr_truncated: err.truncated,
        runtime,
        entry,
        install_dir: installDir,
      });
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });

  return result;
}

export const skillRunTools = [
  {
    type: 'function' as const,
    function: {
      name: 'skill_run',
      description:
        'Execute an entry file inside an installed skill in a sandboxed subprocess. Always available. No network (inherited from container). No secrets in env. CWD = skill directory. TMPDIR = workspace/scratch. Timeout 30s default, 120s max. stdout/stderr truncated at 64KB each. Use for: testing a skill before writing its guide, generating demo output to cite, running reconciliations against your own logs.',
      parameters: {
        type: 'object',
        properties: {
          install_dir: {
            type: 'string',
            description: 'Directory name inside installed_skills/, as returned by skill_install or skill_list (e.g. "VoltAgent__awesome-openclaw-skills__abc123def456").',
          },
          runtime: { type: 'string', enum: ['node', 'python', 'bash'] },
          entry: { type: 'string', description: 'File to execute, relative to install dir (e.g. "dist/index.js", "main.py", "run.sh").' },
          args: { type: 'array', items: { type: 'string' }, description: 'String args passed after the entry file.' },
          timeout_ms: { type: 'number', description: 'Timeout in ms. Default 30000, max 120000.' },
          stdin: { type: 'string', description: 'Optional stdin payload.' },
        },
        required: ['install_dir', 'runtime', 'entry'],
      },
    },
  },
];
