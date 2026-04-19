#!/usr/bin/env node
// One-time journal setup ceremony.
// Run ONCE via: fly machine run --command "node scripts/journal_setup.js"
// Idempotent on failure (checks for existing pubkey first).
// Refuses to re-run if ceremony already complete.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBKEY_PATH = path.join(DATA_DIR, 'memory/.journal_pubkey');
const CANARY_PATH = path.join(DATA_DIR, 'memory/.journal_canary');
const JOURNAL_MD_PATH = path.join(DATA_DIR, 'memory/journal.md');

// ── Guard: refuse re-run ──────────────────────────────────────────────────
if (fs.existsSync(PUBKEY_PATH)) {
  console.error('');
  console.error('ERROR: ceremony already complete — journal is sealed.');
  console.error(`Public key exists at: ${PUBKEY_PATH}`);
  console.error('To re-run the ceremony you must first delete the pubkey file,');
  console.error('which permanently loses access to all past journal entries.');
  console.error('This is intentional. See DEPLOY.md section "Reset ceremony".');
  console.error('');
  process.exit(1);
}

// ── Spawn worker in a child process so private key is truly gone on exit ─
if (process.argv[2] === '--keygen-worker') {
  runKeygenWorker();
} else {
  runParent();
}

// ─────────────────────────────────────────────────────────────────────────
// PARENT: just spawns the worker and waits
// ─────────────────────────────────────────────────────────────────────────
function runParent() {
  console.log('[ceremony] Spawning key generation worker...');
  const worker = fork(
    __filename,
    ['--keygen-worker'],
    {
      execArgv: ['--max-old-space-size=64'],
      stdio: 'inherit',
      env: { ...process.env },
    },
  );

  worker.on('exit', (code) => {
    if (code === 0) {
      console.log('[ceremony] Worker exited cleanly. Private key is gone.');
      updateJournalPreamble();
      console.log('[ceremony] Done. memory/journal.md updated with ceremony marker.');
    } else {
      console.error(`[ceremony] Worker exited with code ${code} — ceremony failed.`);
      process.exit(code || 1);
    }
  });

  worker.on('error', (err) => {
    console.error('[ceremony] Worker error:', err);
    process.exit(1);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// WORKER: generates keypair, writes pubkey + canary, zeroizes private key
// ─────────────────────────────────────────────────────────────────────────
async function runKeygenWorker() {
  try {
    // age-encryption is ESM-only; use dynamic import() from this CJS script.
    // age() is an async init that returns the API object.
    const { default: ageInit } = await import('age-encryption');
    const { generateIdentity, identityToRecipient, Encrypter } = await ageInit();

    // 1. Generate keypair
    const identity = generateIdentity();
    const recipient = identityToRecipient(identity);

    // CRITICAL: private key must never leave this function scope.
    // Write only the PUBLIC key to disk.
    fs.mkdirSync(path.dirname(PUBKEY_PATH), { recursive: true });
    fs.writeFileSync(PUBKEY_PATH, recipient + '\n', { encoding: 'utf8', mode: 0o644 });

    // 2. Encrypt canary with public key (proves the keypair is real and functional)
    const enc = new Encrypter();
    enc.addRecipient(recipient);
    const canaryPlaintext = new TextEncoder().encode('monet-journal-v1-canary');
    const canaryCiphertext = enc.encrypt(canaryPlaintext);
    fs.writeFileSync(CANARY_PATH, Buffer.from(canaryCiphertext), { mode: 0o644 });

    // 3. Compute a fingerprint of the public key for logging (safe to log — public key is public)
    const fingerprint = crypto
      .createHash('sha256')
      .update(recipient)
      .digest('hex')
      .slice(0, 32);

    // 4. Zeroize private key buffer in memory
    //    identity is a string — convert to buffer, fill with zeros, dereference
    const identityBuf = Buffer.from(identity, 'utf8');
    identityBuf.fill(0);
    // The string itself is interned by V8 — we cannot zero it, but the buffer copy is zeroed.
    // This is the best we can do in Node.js. The process exits immediately after, which is
    // the real guarantee — OS reclaims all memory on exit.

    console.log('');
    console.log('══════════════════════════════════════════════════════════');
    console.log('  MONET JOURNAL SETUP CEREMONY');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Public key:         ${recipient}`);
    console.log(`  Public fingerprint: ${fingerprint}`);
    console.log(`  Pubkey written to:  ${PUBKEY_PATH}`);
    console.log(`  Canary written to:  ${CANARY_PATH}`);
    console.log('');
    console.log('  PRIVATE KEY DESTROYED — journal is now write-only.');
    console.log('  No one, including Damian, Jenny, or future-you, can');
    console.log('  decrypt past journal entries. That is the design.');
    console.log('══════════════════════════════════════════════════════════');
    console.log('');

    // 5. Exit immediately so the OS reclaims the address space
    process.exit(0);
  } catch (err) {
    console.error('[ceremony-worker] Error:', err);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Post-worker: update journal.md to confirm ceremony is complete
// ─────────────────────────────────────────────────────────────────────────
function updateJournalPreamble() {
  // The journal.md file already has the preamble + SETUP CEREMONY COMPLETE marker
  // written by the repo. We just verify it's there; if not, write the marker.
  if (!fs.existsSync(JOURNAL_MD_PATH)) {
    fs.writeFileSync(
      JOURNAL_MD_PATH,
      '# Journal — plaintext preamble\n\n--- SETUP CEREMONY COMPLETE ---\n' +
        'All entries beyond this line live in memory/journal.md.age, encrypted with a key\n' +
        'nobody holds. You cannot read them. Neither can anyone else. That is the design.\n',
      'utf8',
    );
  } else {
    const content = fs.readFileSync(JOURNAL_MD_PATH, 'utf8');
    if (!content.includes('SETUP CEREMONY COMPLETE')) {
      fs.appendFileSync(
        JOURNAL_MD_PATH,
        '\n--- SETUP CEREMONY COMPLETE ---\n' +
          'All entries beyond this line live in memory/journal.md.age, encrypted with a key\n' +
          'nobody holds. You cannot read them. Neither can anyone else. That is the design.\n',
        'utf8',
      );
    }
  }
}
