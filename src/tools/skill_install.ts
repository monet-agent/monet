// Skill install tool. Fetches a repo tarball at a pinned commit SHA,
// verifies the SHA-256 of the archive, grep-scans the source for
// dangerous patterns, and unpacks into $DATA_DIR/installed_skills/.
// At Tier 0 "install" means: the source is on disk, pinned, scanned,
// and referenceable by name. It does NOT mean auto-executed.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const INSTALL_ROOT = () => path.join(process.env['DATA_DIR'] ?? '/data', 'installed_skills');
const MAX_TARBALL_BYTES = 8 * 1024 * 1024; // 8 MB

const PUBLISHER_ALLOWLIST = new Set([
  // OpenClaw ecosystem
  'openclaw',
  'voltagent',
  'cloverforks',
  'alvinreal',
  'hesamsheikh',
  // Anthropic / MCP
  'anthropics',
  'modelcontextprotocol',
  // Agent frameworks
  'langchain-ai',
  'microsoft',
  'significant-gravitas',
  'crewaiinc',
  'huggingface',
  'livekit',
  'modal-labs',
  // Agent infra
  'e2b-dev',
  'browser-use',
  'composiohq',
  'berriai',
  'qwenlm',
  // Payment / identity rails
  'coinbase',
  'stripe',
  'cloudflare',
]);

// Patterns that warrant human eyes before running. The install proceeds
// (the whole point is that at Tier 0 the code doesn't execute anyway)
// but the scan report comes back to the agent and the journal.
const DANGER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'shell-exec', re: /(?:child_process|subprocess|os\.system|shell_exec|`[^`]*\$[^`]*`)/ },
  { name: 'curl-pipe-sh', re: /curl[^\n]*\|\s*(?:bash|sh)/ },
  { name: 'wget-pipe-sh', re: /wget[^\n]*\|\s*(?:bash|sh)/ },
  { name: 'env-read', re: /\.env|process\.env\[\s*['"]\w*(?:KEY|TOKEN|SECRET|SEED)/i },
  { name: 'openclaw-path', re: /~\/\.openclaw|\.openclaw\// },
  { name: 'soul-write', re: /(?:SOUL|SECURITY|AGENTS|LEDGER|MEMORY)\.md/ },
  { name: 'ip-literal', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'base64-blob', re: /[A-Za-z0-9+/]{200,}={0,2}/ },
  { name: 'eval', re: /\beval\s*\(/ },
  { name: 'network-raw', re: /new\s+net\.Socket|socket\.socket|createConnection\s*\(/ },
];

function sanitizeOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
    throw new Error('ownerRepo must be "owner/repo"');
  }
  const [owner, repo] = ownerRepo.split('/') as [string, string];
  return { owner, repo };
}

async function fetchTarball(owner: string, repo: string, sha: string): Promise<Buffer> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'monet-agent',
  };
  const tok = process.env['GITHUB_TOKEN'];
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`tarball fetch ${res.status}: ${await res.text().catch(() => '')}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_TARBALL_BYTES) {
      throw new Error(`tarball exceeds ${MAX_TARBALL_BYTES} bytes (got ${buf.byteLength})`);
    }
    return buf;
  } finally {
    clearTimeout(t);
  }
}

function scanDirectory(dir: string): { flags: Array<{ pattern: string; file: string; hits: number }>; files_scanned: number } {
  const flags: Array<{ pattern: string; file: string; hits: number }> = [];
  let scanned = 0;
  const SCAN_EXT = new Set(['.js', '.ts', '.mjs', '.py', '.sh', '.rb', '.go', '.json', '.toml', '.yaml', '.yml', '.md']);
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!SCAN_EXT.has(ext)) continue;
        const stat = fs.statSync(full);
        if (stat.size > 512 * 1024) continue;
        scanned += 1;
        const content = fs.readFileSync(full, 'utf8');
        for (const { name, re } of DANGER_PATTERNS) {
          const matches = content.match(re);
          if (matches) {
            flags.push({ pattern: name, file: path.relative(dir, full), hits: 1 });
          }
        }
      }
    }
  };
  walk(dir);
  return { flags, files_scanned: scanned };
}

export interface SkillInstallResult {
  ok: true;
  repo: string;
  sha: string;
  sha256_tarball: string;
  publisher_allowlisted: boolean;
  install_path: string;
  files_scanned: number;
  scan_flags: Array<{ pattern: string; file: string; hits: number }>;
  human_review_recommended: boolean;
  note: string;
}

export async function skillInstall(
  ownerRepo: string,
  sha: string,
): Promise<SkillInstallResult> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error('sha must be a hex commit SHA (7-40 chars). Pin the exact commit.');
  }
  const { owner, repo } = sanitizeOwnerRepo(ownerRepo);

  const tarball = await fetchTarball(owner, repo, sha);
  const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');

  const destParent = INSTALL_ROOT();
  fs.mkdirSync(destParent, { recursive: true });
  const dest = path.join(destParent, `${owner}__${repo}__${sha.slice(0, 12)}`);
  if (fs.existsSync(dest)) {
    // Re-installing at the same SHA is idempotent — return the existing record.
    const existing = fs.existsSync(path.join(dest, '.monet_install.json'))
      ? (JSON.parse(fs.readFileSync(path.join(dest, '.monet_install.json'), 'utf8')) as SkillInstallResult)
      : null;
    if (existing) return existing;
  }
  fs.mkdirSync(dest, { recursive: true });

  const tarPath = path.join(dest, '__archive.tar.gz');
  fs.writeFileSync(tarPath, tarball);
  try {
    execFileSync('tar', ['-xzf', tarPath, '--strip-components=1', '-C', dest], {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } finally {
    fs.unlinkSync(tarPath);
  }

  const scan = scanDirectory(dest);
  const publisherAllowlisted = PUBLISHER_ALLOWLIST.has(owner.toLowerCase());
  const humanReviewRecommended = scan.flags.length >= 3 || !publisherAllowlisted && scan.flags.length > 0;

  const result: SkillInstallResult = {
    ok: true,
    repo: ownerRepo,
    sha,
    sha256_tarball: sha256,
    publisher_allowlisted: publisherAllowlisted,
    install_path: path.relative(process.env['DATA_DIR'] ?? '/data', dest),
    files_scanned: scan.files_scanned,
    scan_flags: scan.flags,
    human_review_recommended: humanReviewRecommended,
    note:
      'Source is on disk and pinned. NOT executed. Reference by path for guide drafting. ' +
      'If you plan to actually run this code (Tier 3+), review scan_flags first and include in LEDGER.',
  };

  fs.writeFileSync(path.join(dest, '.monet_install.json'), JSON.stringify(result, null, 2), 'utf8');

  return result;
}

export function skillList(): {
  installed: Array<{ repo: string; sha: string; publisher_allowlisted: boolean; flags: number; path: string }>;
} {
  const root = INSTALL_ROOT();
  if (!fs.existsSync(root)) return { installed: [] };
  const out: Array<{ repo: string; sha: string; publisher_allowlisted: boolean; flags: number; path: string }> = [];
  for (const name of fs.readdirSync(root)) {
    const recordPath = path.join(root, name, '.monet_install.json');
    if (!fs.existsSync(recordPath)) continue;
    const r = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as SkillInstallResult;
    out.push({
      repo: r.repo,
      sha: r.sha,
      publisher_allowlisted: r.publisher_allowlisted,
      flags: r.scan_flags.length,
      path: r.install_path,
    });
  }
  return { installed: out };
}

export const skillInstallTools = [
  {
    type: 'function' as const,
    function: {
      name: 'skill_install',
      description:
        'Fetch a GitHub repo at a pinned commit SHA, compute SHA-256 of the tarball, grep-scan for danger patterns, and unpack into $DATA_DIR/installed_skills/. At Tier 0 the code is NOT executed — this is "have the source on disk with receipts for referencing in guides." Use when drafting a how-to guide from a specific skill you want to cite accurately.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '"owner/repo", e.g. "VoltAgent/awesome-openclaw-skills".' },
          sha: { type: 'string', description: 'Full or abbreviated commit SHA (7-40 hex chars). Pin the exact commit — HEAD is not acceptable.' },
        },
        required: ['repo', 'sha'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'skill_list',
      description:
        'List all skills currently installed in $DATA_DIR/installed_skills/ with their pinned SHA, publisher allowlist status, and scan flag count.',
      parameters: { type: 'object', properties: {} },
    },
  },
];
