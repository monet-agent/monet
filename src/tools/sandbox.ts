import { Sandbox } from 'e2b';

// sandbox_exec — run code or shell commands in an E2B remote sandbox.
// The sandbox is disposable: created per call, killed at the end. Full
// internet access inside the sandbox, pip/npm/apt available. Output is
// truncated at 32KB per stream to keep context manageable.
//
// Use this for: (1) actually testing a GitHub skill (clone, install deps,
// run), (2) verifying a web API before proposing to sell a wrapper around
// it, (3) generating demo output to cite in a public_log entry or guide,
// (4) quick calculations beyond what $code_runner handles.
//
// NOT for: long-running services (sandbox is torn down after each call).

const STDOUT_LIMIT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  truncated: { stdout: boolean; stderr: boolean };
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= STDOUT_LIMIT_BYTES) return { text: s, truncated: false };
  return { text: s.slice(0, STDOUT_LIMIT_BYTES) + '\n[...truncated]', truncated: true };
}

export async function sandboxExec(
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SandboxExecResult> {
  const apiKey = process.env['E2B_API_KEY'];
  if (!apiKey) throw new Error('E2B_API_KEY not set — cannot create sandbox.');
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('sandbox_exec requires a non-empty "command" string.');
  }
  const budgetMs = Math.min(Math.max(timeoutMs, 5_000), MAX_TIMEOUT_MS);

  const start = Date.now();
  const sbx = await Sandbox.create({ apiKey, timeoutMs: budgetMs + 30_000 });
  try {
    const result = await sbx.commands.run(command, { timeoutMs: budgetMs });
    const out = truncate(result.stdout ?? '');
    const err = truncate(result.stderr ?? '');
    return {
      stdout: out.text,
      stderr: err.text,
      exit_code: result.exitCode ?? null,
      duration_ms: Date.now() - start,
      truncated: { stdout: out.truncated, stderr: err.truncated },
    };
  } finally {
    try { await sbx.kill(); } catch { /* ignore */ }
  }
}

export const sandboxTools = [
  {
    type: 'function' as const,
    function: {
      name: 'sandbox_exec',
      description:
        'Run a shell command in a disposable E2B remote sandbox. Full internet access; pip, npm, apt available. Use to actually test GitHub repos (clone + install + run), verify external APIs, or generate demo output. Default timeout 60s, max 300s. stdout/stderr truncated at 32KB each. Sandbox is torn down after the call — NOT for long-running services.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run inside the sandbox. Example: "git clone https://github.com/x/y && cd y && pip install -r requirements.txt && python demo.py".',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in ms (5000–300000). Default 60000.',
          },
        },
        required: ['command'],
      },
    },
  },
];
