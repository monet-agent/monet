import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sha256, GENESIS_HASH } from '../hashchain.js';
import { verifierPush } from '../verifier_push.js';

const dataDir = () => process.env['DATA_DIR'] ?? '/data';
const JOURNAL_AGE_PATH = () => path.join(dataDir(), 'memory/journal.md.age');
const PUBKEY_PATH = () => path.join(dataDir(), 'memory/.journal_pubkey');
const SEQ_PATH = () => path.join(dataDir(), 'memory/.journal_seq');
const LOCK_PATH = () => path.join(dataDir(), 'memory/.journal.lock');

interface JournalEntry {
  ts: string;
  text: string;
}

// In-memory buffer for current heartbeat only. Never touches disk in plaintext.
let heartbeatBuffer: JournalEntry[] = [];
let bufferHasEntries = false;

export function journalAppend(text: string): { ok: true } {
  heartbeatBuffer.push({ ts: new Date().toISOString(), text });
  bufferHasEntries = true;
  return { ok: true };
}

export function journalReadCurrentSession(): string {
  if (!bufferHasEntries) {
    throw new Error('No journal entries in the current heartbeat — call journal_append first.');
  }
  return heartbeatBuffer
    .map((e) => `[${e.ts}]\n${e.text}`)
    .join('\n\n---\n\n');
}

export function hasJournalEntries(): boolean {
  return bufferHasEntries;
}

function readLastBlobHash(): string {
  if (!fs.existsSync(SEQ_PATH())) return GENESIS_HASH;
  try {
    const raw = JSON.parse(fs.readFileSync(SEQ_PATH(), 'utf8')) as { last_hash: string };
    return raw.last_hash;
  } catch {
    return GENESIS_HASH;
  }
}

function readSeq(): number {
  if (!fs.existsSync(SEQ_PATH())) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(SEQ_PATH(), 'utf8')) as { seq: number };
    return raw.seq;
  } catch {
    return 0;
  }
}

// Called by heartbeat_loop at end of every heartbeat. Never called by agent.
export async function sealJournalBuffer(): Promise<void> {
  if (!bufferHasEntries) {
    return;
  }

  const pubkeyRaw = fs.existsSync(PUBKEY_PATH())
    ? fs.readFileSync(PUBKEY_PATH(), 'utf8').trim()
    : null;

  if (!pubkeyRaw) {
    console.error('[journal] CRITICAL: public key missing — skipping seal. Run journal_setup.js first.');
    _zeroBuffer();
    return;
  }

  const prevHash = readLastBlobHash();
  const seq = readSeq() + 1;
  const ts = new Date().toISOString();

  const blob = JSON.stringify({
    ts,
    seq,
    prev_hash: prevHash,
    entries: heartbeatBuffer,
  });

  // Encrypt with age public key.
  // age-encryption is ESM-only. TypeScript compiles `import()` to `require()` in
  // CJS mode, which Node rejects for ESM packages with top-level await.
  // We bypass the transform with Function() so the native import() is preserved.
  type AgeApi = { Encrypter: new () => { addRecipient(r: string): void; encrypt(data: Uint8Array | string): Uint8Array } };
  type AgeInit = () => Promise<AgeApi>;
  const ageModule = await (Function('s', 'return import(s)')('age-encryption') as Promise<{ default: AgeInit }>);
  const { Encrypter } = await ageModule.default();
  const enc = new Encrypter();
  enc.addRecipient(pubkeyRaw);
  const ciphertext = enc.encrypt(new TextEncoder().encode(blob));

  const ciphertextBuf = Buffer.from(ciphertext);
  const entryHash = sha256(ciphertextBuf);

  // Atomic append: write entry as a base64 block with a header line
  const record =
    `MONET-JOURNAL-V1 seq=${seq} ts=${ts} prev_hash=${prevHash} entry_hash=${entryHash}\n` +
    ciphertextBuf.toString('base64') +
    '\n';

  await atomicAppend(JOURNAL_AGE_PATH(), record, LOCK_PATH());

  // Update seq state
  fs.writeFileSync(
    SEQ_PATH(),
    JSON.stringify({ seq, last_hash: entryHash }),
    'utf8',
  );

  // Push to R2 verifier (non-blocking on failure)
  await verifierPush('journal', entryHash, seq).catch((e) =>
    console.error('[journal] verifier push failed:', e),
  );

  _zeroBuffer();
}

function _zeroBuffer(): void {
  // Overwrite each string slot with empty string, then clear array
  for (let i = 0; i < heartbeatBuffer.length; i++) {
    const entry = heartbeatBuffer[i];
    if (entry) {
      entry.text = '';
      entry.ts = '';
    }
  }
  heartbeatBuffer = [];
  bufferHasEntries = false;
}

async function atomicAppend(
  filePath: string,
  data: string,
  lockPath: string,
): Promise<void> {
  // Simple lock via exclusive open of a lock file
  let lockFd: number | null = null;
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      break;
    } catch {
      await sleep(50);
    }
  }
  if (lockFd === null) throw new Error('[journal] Could not acquire lock');

  try {
    fs.appendFileSync(filePath, data, { encoding: 'utf8', flag: 'a' });
    // fsync the file
    const fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } finally {
    fs.closeSync(lockFd);
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

// Verify journal hash chain integrity (only over the header metadata — content unreadable).
export function verifyJournalChain(): boolean {
  if (!fs.existsSync(JOURNAL_AGE_PATH())) return true;
  const content = fs.readFileSync(JOURNAL_AGE_PATH(), 'utf8');
  const lines = content.split('\n').filter((l) => l.startsWith('MONET-JOURNAL-V1'));

  let prevHash = GENESIS_HASH;
  for (const line of lines) {
    const parts = line.split(' ');
    const entryHashPart = parts.find((p) => p.startsWith('entry_hash='));
    const prevHashPart = parts.find((p) => p.startsWith('prev_hash='));
    if (!entryHashPart || !prevHashPart) return false;
    const entryHash = entryHashPart.slice('entry_hash='.length);
    const recordPrevHash = prevHashPart.slice('prev_hash='.length);
    if (recordPrevHash !== prevHash) return false;
    prevHash = entryHash;
  }

  // Also verify the stored tip matches
  const storedTip = readLastBlobHash();
  // On first entry prevHash equals storedTip; if any entries, last computed prevHash should equal storedTip
  if (lines.length > 0 && prevHash !== storedTip) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Tool definitions for the LLM
export const journalTools = [
  {
    type: 'function' as const,
    function: {
      name: 'journal_append',
      description:
        'Buffer text into the current heartbeat journal. Encrypted and sealed at heartbeat end — no one can read past entries, including you.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Journal entry text.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'journal_read_current_session',
      description:
        'Return the plaintext of everything written in journal_append during this heartbeat. Throws if no entries exist yet.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];
