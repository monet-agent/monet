// fly_mvp — autonomous MVP deploy tools. Pre-provisioned pool of Fly apps
// (monet-mvp-01..NN) with per-app deploy tokens stored in FLY_MVP_TOKENS
// as JSON { "<slot>": "<deploy-token>" }. Tokens are narrowly scoped to
// their single app: a compromised/confused agent cannot touch monet-agent
// itself or any other Fly resource.
//
// Tools:
//   fly_list_mvp_slots  — what slots exist + per-slot machine state
//   fly_deploy_mvp      — deploy a workspace/<dir> source to a slot
//   fly_mvp_status      — machine state + hostname for a slot
//   fly_mvp_destroy     — scale slot to 0 machines (keeps slot in pool)
//
// The agent never sees token strings — it only references slots by name.
//
// Budget: at most FLY_MVP_DAILY_DEPLOY_CAP deploys across all slots per
// 24h (ledger-scanned). Exceeding the cap throws — no silent no-op.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT = () => path.join(process.env['DATA_DIR'] ?? '/data', 'workspace');
const LEDGER_PATH = () => path.join(process.env['DATA_DIR'] ?? '/data', 'ledger.jsonl');
const DAILY_DEPLOY_CAP = Number(process.env['FLY_MVP_DAILY_DEPLOY_CAP'] ?? '10');
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per deploy
const STATUS_TIMEOUT_MS = 30 * 1000;

const FLYCTL_BIN = process.env['FLYCTL_BIN'] ?? '/usr/local/bin/flyctl';
const DEFAULT_REGION = process.env['FLY_MVP_REGION'] ?? 'yyz';

interface TokenMap { [slot: string]: string }

function readTokenMap(): TokenMap {
  const raw = process.env['FLY_MVP_TOKENS'];
  if (!raw) throw new Error('FLY_MVP_TOKENS not set — no MVP slots provisioned.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FLY_MVP_TOKENS is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FLY_MVP_TOKENS must be a JSON object mapping slot→token.');
  }
  const out: TokenMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || v.length < 20) continue;
    out[k] = v;
  }
  return out;
}

function tokenForSlot(slot: string): string {
  const map = readTokenMap();
  const tok = map[slot];
  if (!tok) {
    const avail = Object.keys(map).sort().join(', ');
    throw new Error(`Slot "${slot}" not in pool. Available: ${avail || '(none)'}.`);
  }
  return tok;
}

function redact(s: string): string {
  // Redact any token-looking string ("FlyV1 ...") from output before returning.
  return s.replace(/FlyV1\s+\S+/g, 'FlyV1 [REDACTED]');
}

// Daily cap: count note entries with category "mvp_deploy" in the last 24h.
function deployCountLast24h(): number {
  if (!fs.existsSync(LEDGER_PATH())) return 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let count = 0;
  const lines = fs.readFileSync(LEDGER_PATH(), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { type?: string; category?: string; ts?: string };
      if (e.type !== 'note' || e.category !== 'mvp_deploy' || !e.ts) continue;
      const t = new Date(e.ts).getTime();
      if (Number.isFinite(t) && t >= cutoff) count += 1;
    } catch { /* malformed line — skip */ }
  }
  return count;
}

function resolveSourceDir(workspacePath: string): string {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new Error('workspace_path must be a non-empty relative path inside workspace/.');
  }
  if (path.isAbsolute(workspacePath)) {
    throw new Error('workspace_path must be relative, not absolute.');
  }
  if (workspacePath.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('workspace_path may not contain ".." segments.');
  }
  const root = WORKSPACE_ROOT();
  const resolved = path.resolve(root, workspacePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('workspace_path resolves outside workspace/.');
  }
  if (!fs.existsSync(resolved)) throw new Error(`workspace path not found: ${workspacePath}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`workspace_path must be a directory, not a file.`);
  if (!fs.existsSync(path.join(resolved, 'Dockerfile'))) {
    throw new Error(`No Dockerfile in ${workspacePath}. Write one via workspace_write first.`);
  }
  return resolved;
}

function ensureFlyToml(sourceDir: string, slot: string, internalPort: number): void {
  const tomlPath = path.join(sourceDir, 'fly.toml');
  if (fs.existsSync(tomlPath)) return;
  const toml =
    `app = "${slot}"\n` +
    `primary_region = "${DEFAULT_REGION}"\n\n` +
    `[build]\n  dockerfile = "Dockerfile"\n\n` +
    `[http_service]\n` +
    `  internal_port = ${internalPort}\n` +
    `  force_https = true\n` +
    `  auto_stop_machines = "stop"\n` +
    `  auto_start_machines = true\n` +
    `  min_machines_running = 0\n\n` +
    `[[vm]]\n` +
    `  size = "shared-cpu-1x"\n` +
    `  memory = "256mb"\n`;
  fs.writeFileSync(tomlPath, toml, 'utf8');
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runFlyctl(args: string[], token: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(FLYCTL_BIN, args, {
      cwd,
      env: { ...process.env, FLY_API_TOKEN: token, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(to);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(to);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

function tailLines(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.slice(-n).join('\n');
}

// ── Tool implementations ───────────────────────────────────────────────────

export interface SlotInfo {
  slot: string;
  machine_count: number;
  any_started: boolean;
  hostname: string;
  note: string;
}

export async function flyListMvpSlots(): Promise<{ slots: SlotInfo[]; daily_deploys_used: number; daily_cap: number }> {
  const map = readTokenMap();
  const slots: SlotInfo[] = [];
  for (const slot of Object.keys(map).sort()) {
    const token = map[slot] as string;
    const r = await runFlyctl(['machines', 'list', '--app', slot, '--json'], token, '/tmp', STATUS_TIMEOUT_MS);
    let machineCount = 0;
    let anyStarted = false;
    let note = '';
    if (r.code === 0) {
      try {
        const arr = JSON.parse(r.stdout) as Array<{ state?: string }>;
        machineCount = arr.length;
        anyStarted = arr.some((m) => m.state === 'started');
      } catch {
        note = 'could not parse machines list';
      }
    } else {
      note = `flyctl exit ${r.code}`;
    }
    slots.push({
      slot,
      machine_count: machineCount,
      any_started: anyStarted,
      hostname: `${slot}.fly.dev`,
      note,
    });
  }
  return { slots, daily_deploys_used: deployCountLast24h(), daily_cap: DAILY_DEPLOY_CAP };
}

export interface DeployResult {
  ok: boolean;
  slot: string;
  hostname: string;
  duration_ms: number;
  logs_tail: string;
  deploys_used_24h: number;
  daily_cap: number;
}

export async function flyDeployMvp(
  slot: string,
  workspacePath: string,
  options: { internal_port?: number; mvp_name?: string } = {},
): Promise<DeployResult> {
  const token = tokenForSlot(slot);
  const used = deployCountLast24h();
  if (used >= DAILY_DEPLOY_CAP) {
    throw new Error(
      `MVP deploy cap hit: ${used}/${DAILY_DEPLOY_CAP} in last 24h. ` +
      `Wait for the window to roll or ask Damian to raise FLY_MVP_DAILY_DEPLOY_CAP.`,
    );
  }
  const sourceDir = resolveSourceDir(workspacePath);
  const internalPort = options.internal_port ?? 8080;
  ensureFlyToml(sourceDir, slot, internalPort);

  const start = Date.now();
  const r = await runFlyctl(
    ['deploy', '--app', slot, '--ha=false', '--yes', '--now'],
    token,
    sourceDir,
    DEPLOY_TIMEOUT_MS,
  );
  const dur = Date.now() - start;
  const ok = r.code === 0 && !r.timedOut;
  const logsTail = redact(tailLines(`${r.stdout}\n${r.stderr}`, 40));

  // Log a note to the ledger for cap-accounting + audit trail. Non-fatal
  // on error (we still return the deploy result so monet can see what
  // happened).
  try {
    const { ledgerAppend } = await import('./ledger.js');
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'note',
      category: 'mvp_deploy',
      amount_cad: 0,
      points_delta: 0,
      description: `fly_deploy_mvp slot=${slot} status=${ok ? 'ok' : 'fail'} mvp=${options.mvp_name ?? workspacePath}`,
      verification: { type: 'api', source: 'flyctl', ref: `${slot}.fly.dev` },
      notes: `MVP_SLOT: ${slot} MVP_NAME: ${options.mvp_name ?? workspacePath} WORKSPACE: ${workspacePath} DURATION_MS: ${dur}`,
    });
  } catch (err) {
    console.warn('[fly_mvp] ledger note append failed:', err);
  }

  return {
    ok,
    slot,
    hostname: `${slot}.fly.dev`,
    duration_ms: dur,
    logs_tail: logsTail,
    deploys_used_24h: used + 1,
    daily_cap: DAILY_DEPLOY_CAP,
  };
}

export interface StatusResult {
  slot: string;
  hostname: string;
  machines: Array<{ id: string; state: string; region: string; image_ref: string }>;
  reachable: boolean;
  http_status: number | null;
}

export async function flyMvpStatus(slot: string): Promise<StatusResult> {
  const token = tokenForSlot(slot);
  const r = await runFlyctl(['machines', 'list', '--app', slot, '--json'], token, '/tmp', STATUS_TIMEOUT_MS);
  const machines: StatusResult['machines'] = [];
  if (r.code === 0) {
    try {
      const arr = JSON.parse(r.stdout) as Array<{
        id?: string; state?: string; region?: string;
        config?: { image?: string };
      }>;
      for (const m of arr) {
        machines.push({
          id: String(m.id ?? ''),
          state: String(m.state ?? '?'),
          region: String(m.region ?? ''),
          image_ref: String(m.config?.image ?? ''),
        });
      }
    } catch { /* tolerate parse failure */ }
  }
  const host = `${slot}.fly.dev`;
  let reachable = false;
  let httpStatus: number | null = null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`https://${host}/`, { method: 'GET', signal: ctrl.signal });
    clearTimeout(to);
    httpStatus = resp.status;
    reachable = resp.status < 500;
  } catch { /* unreachable */ }
  return { slot, hostname: host, machines, reachable, http_status: httpStatus };
}

export async function flyMvpDestroy(slot: string): Promise<{ ok: boolean; slot: string; logs_tail: string }> {
  const token = tokenForSlot(slot);
  // Scale to 0 rather than destroying the app itself — keeps the slot in
  // the pool so monet can redeploy without a human creating a new app.
  const r = await runFlyctl(
    ['scale', 'count', '0', '--app', slot, '--yes'],
    token,
    '/tmp',
    STATUS_TIMEOUT_MS,
  );
  return {
    ok: r.code === 0,
    slot,
    logs_tail: redact(tailLines(`${r.stdout}\n${r.stderr}`, 20)),
  };
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const flyMvpTools = [
  {
    type: 'function' as const,
    function: {
      name: 'fly_list_mvp_slots',
      description:
        'List pre-provisioned Fly app slots you can deploy MVPs to. Returns each slot name, current machine count, whether any are started, public hostname (<slot>.fly.dev), and the 24h deploy cap usage. Call this FIRST before attempting a deploy so you know what slots are free.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fly_deploy_mvp',
      description:
        'Deploy an MVP from workspace/<path> to a pooled Fly slot. Requires a Dockerfile at workspace/<path>/Dockerfile. If fly.toml is missing, a default one is auto-written targeting internal_port (default 8080) in region yyz. The slot must be one of the names returned by fly_list_mvp_slots. Logs a ledger note of category "mvp_deploy" per attempt (counts toward the 24h cap).',
      parameters: {
        type: 'object',
        properties: {
          slot: {
            type: 'string',
            description: 'Target slot, e.g. "monet-mvp-01". Must exist in the pool.',
          },
          workspace_path: {
            type: 'string',
            description: 'Directory under workspace/ containing the Dockerfile, e.g. "agent-memory-001".',
          },
          internal_port: {
            type: 'number',
            description: 'Port your container listens on (for the auto-generated fly.toml). Default 8080.',
          },
          mvp_name: {
            type: 'string',
            description: 'Optional human-readable name for the MVP (recorded in the ledger note for later cross-reference).',
          },
        },
        required: ['slot', 'workspace_path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fly_mvp_status',
      description:
        'Get the current state of an MVP slot: machine list (id/state/region/image), hostname, and an HTTP reachability check. Use after a deploy to confirm the MVP is actually live before claiming endpoint_live.',
      parameters: {
        type: 'object',
        properties: {
          slot: { type: 'string', description: 'Slot name, e.g. "monet-mvp-01".' },
        },
        required: ['slot'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fly_mvp_destroy',
      description:
        'Scale a slot to 0 machines. Keeps the slot name in the pool so you can redeploy later without a human re-creating it. Use when an MVP has failed validation and you want to free the slot.',
      parameters: {
        type: 'object',
        properties: {
          slot: { type: 'string', description: 'Slot to scale to 0, e.g. "monet-mvp-01".' },
        },
        required: ['slot'],
      },
    },
  },
];
