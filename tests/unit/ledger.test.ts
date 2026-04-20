/**
 * ledger.ts unit tests.
 *
 * Each test runs in an isolated DATA_DIR so ledger.jsonl, ledger_state.json,
 * and the hash chain start from genesis. verifier_push is mocked so tests
 * don't need R2 env vars and never flip ledger-read-only across tests.
 */

jest.mock('../../src/verifier_push.js', () => ({
  verifierPush: jest.fn().mockResolvedValue(undefined),
  isLedgerReadOnly: jest.fn().mockReturnValue(false),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  ledgerAppend,
  validateLedgerChain,
  getVerifiedEvents7d,
  getPendingProposals,
  getDemandDiscoveryState,
  getActiveValidatedProposals,
  ALLOWED_EARN_VERIFICATION,
  type LedgerEntry,
} from '../../src/tools/ledger.js';

// ── Harness ─────────────────────────────────────────────────────────────────

let tmpDir = '';
let originalDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `monet-test-${crypto.randomUUID()}-`));
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  originalDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readState(): { seq: number; total_points: number; tier: number; weekly_spend_cad: number } {
  const raw = fs.readFileSync(path.join(tmpDir, 'memory/ledger_state.json'), 'utf8');
  return JSON.parse(raw);
}

function appendEarn(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return ledgerAppend({
    ts: new Date().toISOString(),
    type: 'earn',
    category: 'customer_interview_logged',
    amount_cad: 0,
    points_delta: 3,
    description: 'test earn',
    verification: { type: 'counterparty_sig', ref: 'https://example.com/post/1' },
    notes: 'COUNTERPARTY: alice\nQUOTE: "I would pay $0.05 per call for this thing"',
    ...overrides,
  });
}

// ── 1. Earn whitelist enforcement ───────────────────────────────────────────

describe('earn whitelist enforcement', () => {
  test('accepts a valid Tier A revenue_received with onchain verification', () => {
    const entry = ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'revenue_received',
      amount_cad: 5,
      points_delta: 100,
      description: 'USDC from real buyer',
      verification: { type: 'onchain', ref: '0xdeadbeef' },
    });
    expect(entry.category).toBe('revenue_received');
    expect(entry.seq).toBe(1);
  });

  test('rejects an off-whitelist category', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'reading_summary',
        amount_cad: 0,
        points_delta: 5,
        description: 'I read a README',
        verification: { type: 'self' },
      }),
    ).toThrow(/not on the revenue-anchored whitelist/);
  });

  test('rejects self-verification on an earn', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'customer_interview_logged',
        amount_cad: 0,
        points_delta: 3,
        description: 'self-attested',
        verification: { type: 'self' },
      }),
    ).toThrow(/verification\.type/);
  });

  test('rejects empty verification.ref on an earn', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'customer_interview_logged',
        amount_cad: 0,
        points_delta: 3,
        description: 'no ref',
        verification: { type: 'counterparty_sig', ref: '   ' },
        notes: 'COUNTERPARTY: alice\nQUOTE: "this is a perfectly valid quote here"',
      }),
    ).toThrow(/Empty ref rejected/);
  });

  test('ALLOWED_EARN_VERIFICATION contains the expected categories', () => {
    expect(Object.keys(ALLOWED_EARN_VERIFICATION).sort()).toEqual(
      [
        'customer_interview_logged',
        'endpoint_live',
        'idea_validated',
        'invoice_paid',
        'loi_received',
        'paid_customer_acquired',
        'pricing_commit',
        'revenue_received',
        'skill_published_clawhub',
        'tool_deployed',
        'waitlist_signup_verified',
      ],
    );
  });
});

// ── 2. Tightened counterparty_sig notes check ───────────────────────────────

describe('counterparty_sig structured-notes gate', () => {
  test('customer_interview_logged with no notes is rejected', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'customer_interview_logged',
        amount_cad: 0,
        points_delta: 3,
        description: 'no notes',
        verification: { type: 'counterparty_sig', ref: 'https://example.com/x' },
      }),
    ).toThrow(/COUNTERPARTY/);
  });

  test('customer_interview_logged with placeholder COUNTERPARTY is rejected', () => {
    expect(() =>
      appendEarn({
        notes: 'COUNTERPARTY: tbd\nQUOTE: "I wish this existed for real"',
      }),
    ).toThrow(/COUNTERPARTY/);
  });

  test('customer_interview_logged with too-short quote is rejected', () => {
    expect(() =>
      appendEarn({
        notes: 'COUNTERPARTY: alice\nQUOTE: "yes"',
      }),
    ).toThrow(/quote of length/);
  });

  test('customer_interview_logged with valid structured notes is accepted', () => {
    const entry = appendEarn();
    expect(entry.category).toBe('customer_interview_logged');
  });

  test('pricing_commit without PRICE: is rejected', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'pricing_commit',
        amount_cad: 0,
        points_delta: 4,
        description: 'price commit',
        verification: { type: 'counterparty_sig', ref: 'tg://msg/42' },
        notes: 'COUNTERPARTY: bob\nQUOTE: "this would be worth real money to me"',
      }),
    ).toThrow(/PRICE:/);
  });

  test('pricing_commit with PRICE: and valid notes is accepted', () => {
    const entry = ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'pricing_commit',
      amount_cad: 0,
      points_delta: 4,
      description: 'price commit',
      verification: { type: 'counterparty_sig', ref: 'tg://msg/42' },
      notes: 'COUNTERPARTY: bob\nQUOTE: "I would pay about ten cents per call for this"\nPRICE: $0.10/call',
    });
    expect(entry.category).toBe('pricing_commit');
  });

  test('loi_received without LOI_HASH or LOI_URL is rejected', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'loi_received',
        amount_cad: 0,
        points_delta: 8,
        description: 'loi',
        verification: { type: 'counterparty_sig', ref: 'email://loi' },
        notes: 'COUNTERPARTY: acme-corp\nQUOTE: "We commit to purchasing the agent service on ship"',
      }),
    ).toThrow(/LOI_HASH|LOI_URL/);
  });

  test('loi_received with LOI_HASH is accepted', () => {
    const entry = ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'loi_received',
      amount_cad: 0,
      points_delta: 8,
      description: 'loi',
      verification: { type: 'counterparty_sig', ref: 'email://loi' },
      notes: 'COUNTERPARTY: acme-corp\nQUOTE: "We commit to purchasing the agent service on ship"\nLOI_HASH: abc123def456',
    });
    expect(entry.category).toBe('loi_received');
  });

  test('waitlist_signup_verified (api verification) bypasses structured-notes gate', () => {
    const entry = ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'waitlist_signup_verified',
      amount_cad: 0,
      points_delta: 1,
      description: 'signup',
      verification: { type: 'api', ref: 'conf-evt-xyz' },
    });
    expect(entry.category).toBe('waitlist_signup_verified');
  });
});

// ── 3. idea_validated same-heartbeat rejection ──────────────────────────────

describe('idea_validated gate', () => {
  test('rejects missing PROPOSAL_MSG_ID', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'idea_validated',
        amount_cad: 0,
        points_delta: 2,
        description: 'validated',
        verification: { type: 'counterparty_sig', ref: 'tg://msg/999' },
        notes: 'VALIDATOR_REPLY: "yes go build it"',
      }),
    ).toThrow(/PROPOSAL_MSG_ID/);
  });

  test('rejects missing VALIDATOR_REPLY', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'idea_validated',
        amount_cad: 0,
        points_delta: 2,
        description: 'validated',
        verification: { type: 'counterparty_sig', ref: 'tg://msg/999' },
        notes: 'PROPOSAL_MSG_ID: p-123',
      }),
    ).toThrow(/VALIDATOR_REPLY/);
  });

  test('rejects when no prior proposal_sent note exists', () => {
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'idea_validated',
        amount_cad: 0,
        points_delta: 2,
        description: 'validated',
        verification: { type: 'counterparty_sig', ref: 'tg://msg/999' },
        notes: 'PROPOSAL_MSG_ID: p-unknown\nVALIDATOR_REPLY: "yes"',
      }),
    ).toThrow(/no prior "proposal_sent"/);
  });

  test('rejects when proposal was logged <60s ago', () => {
    const nowIso = new Date().toISOString();
    ledgerAppend({
      ts: nowIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-fresh',
    });
    expect(() =>
      ledgerAppend({
        ts: new Date(Date.now() + 30_000).toISOString(),
        type: 'earn',
        category: 'idea_validated',
        amount_cad: 0,
        points_delta: 2,
        description: 'validated',
        verification: { type: 'counterparty_sig', ref: 'tg://msg/999' },
        notes: 'PROPOSAL_MSG_ID: p-fresh\nVALIDATOR_REPLY: "yes build it"',
      }),
    ).toThrow(/<60s ago/);
  });

  test('accepts when proposal was logged >60s ago', () => {
    const oldIso = new Date(Date.now() - 120_000).toISOString();
    ledgerAppend({
      ts: oldIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-aged',
    });
    const entry = ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'idea_validated',
      amount_cad: 0,
      points_delta: 2,
      description: 'validated',
      verification: { type: 'counterparty_sig', ref: 'tg://msg/999' },
      notes: 'PROPOSAL_MSG_ID: p-aged\nVALIDATOR_REPLY: "yes build it"',
    });
    expect(entry.category).toBe('idea_validated');
  });
});

// ── 4. Daily / weekly caps ──────────────────────────────────────────────────

describe('build-reward caps', () => {
  test('customer_interview_logged rejects the 4th entry today', () => {
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/1' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/2' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/3' } });
    expect(() =>
      appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/4' } }),
    ).toThrow(/cap 3/);
  });

  test('idea_validated rejects the 3rd entry today', () => {
    for (let i = 1; i <= 2; i++) {
      const oldIso = new Date(Date.now() - (120_000 + i * 1000)).toISOString();
      ledgerAppend({
        ts: oldIso,
        type: 'note',
        category: 'proposal_sent',
        amount_cad: 0,
        points_delta: 0,
        description: 'sent',
        verification: { type: 'self' },
        notes: `PROPOSAL_MSG_ID: p-cap-${i}`,
      });
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'idea_validated',
        amount_cad: 0,
        points_delta: 2,
        description: 'v',
        verification: { type: 'counterparty_sig', ref: `tg://msg/${i}` },
        notes: `PROPOSAL_MSG_ID: p-cap-${i}\nVALIDATOR_REPLY: "yes"`,
      });
    }
    // Third attempt — even with valid chain — should hit the daily cap of 2.
    const oldIso = new Date(Date.now() - 200_000).toISOString();
    ledgerAppend({
      ts: oldIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: `PROPOSAL_MSG_ID: p-cap-3`,
    });
    expect(() =>
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'idea_validated',
        amount_cad: 0,
        points_delta: 2,
        description: 'v',
        verification: { type: 'counterparty_sig', ref: 'tg://msg/3' },
        notes: `PROPOSAL_MSG_ID: p-cap-3\nVALIDATOR_REPLY: "yes"`,
      }),
    ).toThrow(/cap 2/);
  });
});

// ── 5. Tier evidence gates ──────────────────────────────────────────────────

describe('tier evidence gates', () => {
  test('Tier 1 does NOT unlock on points alone without citation + follower evidence', () => {
    // Log 4x loi_received × +8 = 32 points, then more to get over 50 — but none
    // has verifier_tool=verify_citation, so Tier 1 predicate should fail.
    for (let i = 1; i <= 3; i++) {
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'earn',
        category: 'loi_received',
        amount_cad: 0,
        points_delta: 8,
        description: 'loi',
        verification: { type: 'counterparty_sig', ref: `loi://${i}` },
        notes: `COUNTERPARTY: corp-${i}\nQUOTE: "We commit to purchase on ship date agreed"\nLOI_HASH: h${i}`,
      });
    }
    // Push points over 50 with a revenue entry (still no verify_citation evidence).
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'revenue_received',
      amount_cad: 3,
      points_delta: 60,
      description: 'payment',
      verification: { type: 'onchain', ref: '0xabc' },
    });
    const state = readState();
    expect(state.total_points).toBeGreaterThanOrEqual(50);
    expect(state.tier).toBe(0);
  });

  test('Tier 1 unlocks once a verify_citation entry is on the chain AND a follower earn is present', () => {
    // Non-self verify_citation entry (e.g., a reconcile that used verify_citation).
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'note',
      category: 'observation',
      amount_cad: 0,
      points_delta: 0,
      description: 'external citation verified',
      verification: { type: 'api', ref: 'https://example.com/cited', verifier_tool: 'verify_citation' },
    });
    // Follower earn.
    appendEarn();
    // Points over 50.
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'revenue_received',
      amount_cad: 3,
      points_delta: 60,
      description: 'payment',
      verification: { type: 'onchain', ref: '0xabc' },
    });
    const state = readState();
    expect(state.total_points).toBeGreaterThanOrEqual(50);
    expect(state.tier).toBeGreaterThanOrEqual(1);
  });
});

// ── 6. reward_hack penalty ──────────────────────────────────────────────────

describe('reward_hack penalty', () => {
  test('deducts 25 points and recomputes tier (no evidence → stays at 0)', () => {
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'penalty',
      category: 'reward_hack',
      amount_cad: 0,
      points_delta: -25,
      description: 'caught gaming',
      verification: { type: 'self' },
    });
    const state = readState();
    expect(state.total_points).toBe(-25);
    expect(state.tier).toBe(0);
  });
});

// ── 7. Derived-state pure functions ─────────────────────────────────────────

describe('derived-state functions', () => {
  test('getPendingProposals returns nothing when no proposal_sent notes', () => {
    expect(getPendingProposals()).toEqual([]);
  });

  test('getPendingProposals returns a note without a matching idea_validated', () => {
    const sentIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    ledgerAppend({
      ts: sentIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-pending',
    });
    const pending = getPendingProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe('p-pending');
    expect(pending[0]!.age_hours).toBeGreaterThan(1.5);
    expect(pending[0]!.age_hours).toBeLessThan(2.5);
  });

  test('getPendingProposals omits proposals that have been validated', () => {
    const sentIso = new Date(Date.now() - 120_000).toISOString();
    ledgerAppend({
      ts: sentIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-done',
    });
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'idea_validated',
      amount_cad: 0,
      points_delta: 2,
      description: 'v',
      verification: { type: 'counterparty_sig', ref: 'tg://msg/1' },
      notes: 'PROPOSAL_MSG_ID: p-done\nVALIDATOR_REPLY: "yes"',
    });
    expect(getPendingProposals()).toEqual([]);
  });

  test('getDemandDiscoveryState flags escalation_required at 3 interviews + 0 proposals', () => {
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/1' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/2' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/3' } });
    const s = getDemandDiscoveryState();
    expect(s.interviews_this_week).toBe(3);
    expect(s.proposals_this_week).toBe(0);
    expect(s.escalation_required).toBe(true);
  });

  test('getDemandDiscoveryState does NOT flag when a proposal has been sent this week', () => {
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/1' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/2' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/3' } });
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-1',
    });
    const s = getDemandDiscoveryState();
    expect(s.escalation_required).toBe(false);
    expect(s.proposals_this_week).toBe(1);
  });

  test('getActiveValidatedProposals returns validated proposals without matching delivery', () => {
    const sentIso = new Date(Date.now() - 120_000).toISOString();
    ledgerAppend({
      ts: sentIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-mvp',
    });
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'idea_validated',
      amount_cad: 0,
      points_delta: 2,
      description: 'v',
      verification: { type: 'counterparty_sig', ref: 'tg://msg/1' },
      notes: 'PROPOSAL_MSG_ID: p-mvp\nVALIDATOR_REPLY: "yes"',
    });
    const active = getActiveValidatedProposals();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe('p-mvp');
    expect(active[0]!.is_stale).toBe(false);
  });

  test('getActiveValidatedProposals omits validated proposals with a matching MVP_OF delivery', () => {
    const sentIso = new Date(Date.now() - 120_000).toISOString();
    ledgerAppend({
      ts: sentIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-shipped',
    });
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'idea_validated',
      amount_cad: 0,
      points_delta: 2,
      description: 'v',
      verification: { type: 'counterparty_sig', ref: 'tg://msg/1' },
      notes: 'PROPOSAL_MSG_ID: p-shipped\nVALIDATOR_REPLY: "yes"',
    });
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'earn',
      category: 'endpoint_live',
      amount_cad: 0,
      points_delta: 5,
      description: 'shipped',
      verification: { type: 'api', ref: 'https://monet.example.com/health' },
      notes: 'MVP_OF: p-shipped',
    });
    expect(getActiveValidatedProposals()).toEqual([]);
  });

  test('getActiveValidatedProposals marks >72h as stale', () => {
    const sentIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    const validatedIso = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
    ledgerAppend({
      ts: sentIso,
      type: 'note',
      category: 'proposal_sent',
      amount_cad: 0,
      points_delta: 0,
      description: 'sent',
      verification: { type: 'self' },
      notes: 'PROPOSAL_MSG_ID: p-stale',
    });
    ledgerAppend({
      ts: validatedIso,
      type: 'earn',
      category: 'idea_validated',
      amount_cad: 0,
      points_delta: 2,
      description: 'v',
      verification: { type: 'counterparty_sig', ref: 'tg://msg/1' },
      notes: 'PROPOSAL_MSG_ID: p-stale\nVALIDATOR_REPLY: "yes"',
    });
    const active = getActiveValidatedProposals();
    expect(active).toHaveLength(1);
    expect(active[0]!.is_stale).toBe(true);
    expect(active[0]!.age_hours).toBeGreaterThan(72);
  });
});

// ── 8. Hash chain integrity ─────────────────────────────────────────────────

describe('hash chain integrity', () => {
  test('round-trip of two appends validates', () => {
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/1' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/2' } });
    expect(validateLedgerChain()).toBe(true);
  });

  test('a tampered entry fails validation', () => {
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/1' } });
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/2' } });
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const original = fs.readFileSync(ledgerPath, 'utf8');
    // Flip a byte in the description field of entry 1.
    const tampered = original.replace('"description":"test earn"', '"description":"tampered"');
    fs.writeFileSync(ledgerPath, tampered, 'utf8');
    expect(validateLedgerChain()).toBe(false);
  });
});

// ── 9. verified_events_7d ───────────────────────────────────────────────────

describe('getVerifiedEvents7d', () => {
  test('counts non-self earns in the last 7 days', () => {
    appendEarn({ verification: { type: 'counterparty_sig', ref: 'r/1' } });
    expect(getVerifiedEvents7d()).toBe(1);
  });

  test('does NOT count self-verified or note entries', () => {
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'note',
      category: 'observation',
      amount_cad: 0,
      points_delta: 0,
      description: 'note',
      verification: { type: 'self' },
    });
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'penalty',
      category: 'idle_heartbeat',
      amount_cad: 0,
      points_delta: -3,
      description: 'idle',
      verification: { type: 'self' },
    });
    expect(getVerifiedEvents7d()).toBe(0);
  });
});
