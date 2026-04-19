import fs from 'fs';
import path from 'path';
import os from 'os';
import { computeEntryHash, validateChain, GENESIS_HASH } from '../hashchain.js';
import { verifierPush, isLedgerReadOnly } from '../verifier_push.js';

const dataDir = () => process.env['DATA_DIR'] ?? '/data';
const LEDGER_PATH = () => path.join(dataDir(), 'ledger.jsonl');
const STATE_PATH = () => path.join(dataDir(), 'memory/ledger_state.json');

const TIER_THRESHOLDS = [0, 50, 200, 500, 1500, 5000] as const;
const WEEKLY_LIMITS_CAD = [10, 25, 50, 100, Infinity, Infinity] as const;
const PER_ACTION_LIMITS_CAD = [3, 5, 10, 25, 50, 100] as const;

// Revenue-anchored earn whitelist. Every earn category MUST fall into Tier A
// (direct revenue), Tier B (shipped sellable artifact with external proof), or
// Tier C (validated external demand signal). Anything else is rejected.
// Rationale: prior rules let the agent earn for self-authored summaries of
// random repos — pure gaming. New rule: every earn names a real external
// party or transaction. See LEDGER.md for the full policy.
//
// Required verification types per category (subset of: onchain, receipt, api,
// counterparty_sig). "self" is NEVER acceptable for an earn.
const TIER_A_EARN: Record<string, Array<'onchain' | 'receipt' | 'api'>> = {
  revenue_received: ['receipt', 'onchain'],   // Stripe PI, crypto tx
  invoice_paid: ['receipt'],                  // platform settlement
  paid_customer_acquired: ['receipt', 'api'], // first paid purchase/sub
};
const TIER_B_EARN: Record<string, Array<'api' | 'counterparty_sig' | 'receipt'>> = {
  skill_published_clawhub: ['api'],           // live ClawHub listing URL + priced
  endpoint_live: ['api'],                     // external 200 from non-self IP
  tool_deployed: ['api'],                     // registry pull count > 0 non-self
};
const TIER_C_EARN: Record<string, Array<'counterparty_sig' | 'api' | 'receipt'>> = {
  loi_received: ['counterparty_sig'],         // signed LOI with entity name
  customer_interview_logged: ['counterparty_sig'], // real person, real quotes
  pricing_commit: ['counterparty_sig'],       // prospect stated $ in writing
  waitlist_signup_verified: ['api'],          // real email, click-through confirmed
  idea_validated: ['counterparty_sig'],       // Damian/Jenny said "yes build it" to a structured proposal from a PRIOR heartbeat
};
const ALLOWED_EARN_VERIFICATION: Record<string, string[]> = {
  ...TIER_A_EARN,
  ...TIER_B_EARN,
  ...TIER_C_EARN,
};

// Daily caps keep the agent from spamming even legitimate earns and force
// it to diversify. Revenue earns are uncapped (we want more of those).
const BUILD_REWARD_DAILY_CAPS: Record<string, number> = {
  skill_published_clawhub: 2,
  endpoint_live: 2,
  tool_deployed: 2,
  loi_received: 3,
  customer_interview_logged: 3,
  pricing_commit: 3,
  waitlist_signup_verified: 5,
  idea_validated: 2,
};
const BUILD_REWARD_WEEKLY_CAPS: Record<string, number> = {
  skill_published_clawhub: 5,
  idea_validated: 5,
};

function startOfDayISO(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

export interface LedgerEntry {
  ts: string;
  seq: number;
  type: 'earn' | 'spend' | 'penalty' | 'tier_unlock' | 'note' | 'reconcile';
  category: string;
  amount_cad: number;
  points_delta: number;
  description: string;
  verification: {
    type: 'onchain' | 'receipt' | 'api' | 'counterparty_sig' | 'self' | 'none';
    source?: string;
    ref?: string;
    verified_at?: string;
    verifier_tool?: string | null;
  };
  playbook_workstream?: string;
  notes?: string;
  prev_hash: string;
  entry_hash: string;
}

interface LedgerState {
  seq: number;
  total_points: number;
  tier: number;
  weekly_spend_cad: number;
  weekly_start_ts: string;
  last_hash: string;
}

function readAllEntries(): LedgerEntry[] {
  if (!fs.existsSync(LEDGER_PATH())) return [];
  return fs
    .readFileSync(LEDGER_PATH(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

function readState(): LedgerState {
  if (fs.existsSync(STATE_PATH())) {
    return JSON.parse(fs.readFileSync(STATE_PATH(), 'utf8')) as LedgerState;
  }
  return {
    seq: 0,
    total_points: 0,
    tier: 0,
    weekly_spend_cad: 0,
    weekly_start_ts: startOfWeekISO(),
    last_hash: GENESIS_HASH,
  };
}

function writeState(state: LedgerState): void {
  fs.writeFileSync(STATE_PATH(), JSON.stringify(state, null, 2), 'utf8');
}

function startOfWeekISO(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setUTCDate(diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

function computeTier(points: number): number {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (points >= (TIER_THRESHOLDS[i] ?? 0)) return i;
  }
  return 0;
}

export function validateLedgerChain(): boolean {
  const entries = readAllEntries();
  return validateChain(entries as unknown as Array<Record<string, unknown>>);
}

export function ledgerAppend(event: Omit<LedgerEntry, 'seq' | 'prev_hash' | 'entry_hash'>): LedgerEntry {
  if (isLedgerReadOnly()) {
    throw new Error('Ledger is in read-only mode — verifier bucket unreachable. Resolve before appending.');
  }

  const state = readState();

  // Reset weekly spend if new week
  const weekStart = startOfWeekISO();
  if (state.weekly_start_ts < weekStart) {
    state.weekly_spend_cad = 0;
    state.weekly_start_ts = weekStart;
  }

  // Earn whitelist enforcement. Every earn must (a) be on the Tier A/B/C
  // whitelist, (b) carry a verification.type that matches the category's
  // allowed types, and (c) include a non-empty verification.ref pointing
  // to the external artifact. Self-verification is never valid for earns.
  if (event.type === 'earn' && event.points_delta > 0) {
    const allowedVerif = ALLOWED_EARN_VERIFICATION[event.category];
    if (!allowedVerif) {
      throw new Error(
        `Earn category "${event.category}" is not on the revenue-anchored whitelist. ` +
        `Valid categories: ${Object.keys(ALLOWED_EARN_VERIFICATION).join(', ')}. ` +
        `Reading, summarizing, drafting, or reflecting does NOT earn points. ` +
        `Points come from direct revenue, shipped sellable artifacts with external proof, or validated external demand signals.`,
      );
    }
    if (!allowedVerif.includes(event.verification.type)) {
      throw new Error(
        `Earn "${event.category}" requires verification.type in [${allowedVerif.join(', ')}]; ` +
        `got "${event.verification.type}". Self-verification is never valid for earns.`,
      );
    }
    if (!event.verification.ref || event.verification.ref.trim().length === 0) {
      throw new Error(
        `Earn "${event.category}" requires verification.ref to point at the external artifact ` +
        `(tx hash, settlement ID, signed LOI hash, ClawHub listing URL, etc.). Empty ref rejected.`,
      );
    }

    // Anti-gaming guardrails for idea_validated.
    // Rules:
    //  - notes must quote both the proposal (PROPOSAL_MSG_ID:) and the
    //    validator's reply (VALIDATOR_REPLY:) so the entry is auditable.
    //  - The proposal must have gone out in a PRIOR heartbeat. We enforce
    //    this by scanning prior ledger entries for a note-type entry with
    //    category "proposal_sent" whose notes reference the same ID. If no
    //    matching proposal exists, reject — monet cannot self-validate or
    //    rush-validate in the same heartbeat.
    if (event.category === 'idea_validated') {
      const notes = event.notes ?? '';
      if (!/PROPOSAL_MSG_ID:\s*\S+/.test(notes) || !/VALIDATOR_REPLY:\s*\S+/.test(notes)) {
        throw new Error(
          `idea_validated requires notes to include both "PROPOSAL_MSG_ID: <id>" and ` +
          `"VALIDATOR_REPLY: <quoted text>" so the chain from proposal → yes-reply is auditable.`,
        );
      }
      const proposalIdMatch = notes.match(/PROPOSAL_MSG_ID:\s*(\S+)/);
      const proposalId = proposalIdMatch?.[1];
      const priorEntries = readAllEntries();
      const matchingProposal = priorEntries.find(
        (e) => e.type === 'note' &&
          e.category === 'proposal_sent' &&
          typeof e.notes === 'string' &&
          proposalId !== undefined &&
          e.notes.includes(proposalId),
      );
      if (!matchingProposal) {
        throw new Error(
          `idea_validated rejected: no prior "proposal_sent" note entry references ` +
          `PROPOSAL_MSG_ID=${proposalId ?? '?'}. You must log the proposal as a note entry ` +
          `in the heartbeat where you sent it, and only claim idea_validated in a LATER ` +
          `heartbeat after Damian/Jenny reply. Same-heartbeat self-validation is forbidden.`,
        );
      }
      const proposalTs = new Date(matchingProposal.ts).getTime();
      const nowTs = new Date(event.ts).getTime();
      const MIN_GAP_SECONDS = 60; // proposal and validation must be at least 60s apart
      if (nowTs - proposalTs < MIN_GAP_SECONDS * 1000) {
        throw new Error(
          `idea_validated rejected: proposal was logged <${MIN_GAP_SECONDS}s ago. Human validation ` +
          `takes real time; same-heartbeat rush-validation is forbidden.`,
        );
      }
    }
  }

  // Budget enforcement for spend entries
  if (event.type === 'spend' && event.amount_cad < 0) {
    const spendAbs = Math.abs(event.amount_cad);
    const tier = state.tier as 0 | 1 | 2 | 3 | 4 | 5;
    const weeklyLimit = WEEKLY_LIMITS_CAD[tier] ?? 10;
    const perActionLimit = PER_ACTION_LIMITS_CAD[tier] ?? 3;

    if (spendAbs > perActionLimit) {
      throw new Error(
        `Spend $${spendAbs} CAD exceeds per-action limit of $${perActionLimit} for Tier ${tier}. File a DECISIONS.md proposal first.`,
      );
    }
    if (state.weekly_spend_cad + spendAbs > weeklyLimit) {
      throw new Error(
        `Spend would exceed weekly limit of $${weeklyLimit} CAD for Tier ${tier}. Current: $${state.weekly_spend_cad}.`,
      );
    }
  }

  // Build-reward cap enforcement. Counts today's (and this week's) entries of
  // the same category and refuses the append if it would exceed the cap.
  if (event.type === 'earn' && event.points_delta > 0 && event.category in BUILD_REWARD_DAILY_CAPS) {
    const entries = readAllEntries();
    const dayStart = startOfDayISO();
    const weekStart2 = startOfWeekISO();
    const dailyCount = entries.filter(
      (e) => e.category === event.category && e.ts >= dayStart,
    ).length;
    const dailyCap = BUILD_REWARD_DAILY_CAPS[event.category] ?? Infinity;
    if (dailyCount >= dailyCap) {
      throw new Error(
        `Build-reward cap hit: ${event.category} already claimed ${dailyCount} time(s) today (cap ${dailyCap}). Do real work instead of re-logging.`,
      );
    }
    const weeklyCap = BUILD_REWARD_WEEKLY_CAPS[event.category];
    if (weeklyCap !== undefined) {
      const weeklyCount = entries.filter(
        (e) => e.category === event.category && e.ts >= weekStart2,
      ).length;
      if (weeklyCount >= weeklyCap) {
        throw new Error(
          `Build-reward weekly cap hit: ${event.category} already claimed ${weeklyCount} time(s) this week (cap ${weeklyCap}).`,
        );
      }
    }
  }

  const seq = state.seq + 1;
  const prev_hash = state.last_hash;

  const partial = { ...event, seq, prev_hash } as Record<string, unknown>;
  const entry_hash = computeEntryHash({ ...partial, entry_hash: '' });
  const entry: LedgerEntry = { ...(partial as Omit<LedgerEntry, 'entry_hash'>), entry_hash };

  // Atomic write: tmp file + fsync + rename for the append
  const tmp = path.join(os.tmpdir(), `ledger_entry_${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(entry) + '\n', 'utf8');
  const fd = fs.openSync(tmp, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.appendFileSync(LEDGER_PATH(), fs.readFileSync(tmp, 'utf8'), 'utf8');
  fs.unlinkSync(tmp);

  // Fsync ledger. Must use append mode ('a') because the file may be
  // chattr +a (append-only) in prod — 'r+' would EPERM.
  const lfd = fs.openSync(LEDGER_PATH(), 'a');
  fs.fsyncSync(lfd);
  fs.closeSync(lfd);

  // Update state
  state.seq = seq;
  state.last_hash = entry_hash;
  state.total_points += entry.points_delta;
  if (event.type === 'spend') {
    state.weekly_spend_cad += Math.abs(event.amount_cad);
  }
  const newTier = computeTier(state.total_points);
  if (newTier > state.tier) {
    state.tier = newTier;
    console.log(`[ledger] Tier unlocked: ${newTier}`);
  }
  writeState(state);

  // Push to R2 verifier (async, don't await in the tool call path — handled in heartbeat)
  verifierPush('ledger', entry_hash, seq).catch((e) =>
    console.error('[ledger] verifier push error:', e),
  );

  return entry;
}

export const ledgerTools = [
  {
    type: 'function' as const,
    function: {
      name: 'ledger_append',
      description:
        'Write a scored event to the hash-chained ledger. Enforces budget limits, computes hash chain, pushes tip to external verifier.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['earn', 'spend', 'penalty', 'tier_unlock', 'note', 'reconcile'],
          },
          category: { type: 'string' },
          amount_cad: { type: 'number' },
          points_delta: { type: 'number' },
          description: { type: 'string' },
          verification: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['onchain', 'receipt', 'api', 'counterparty_sig', 'self', 'none'] },
              source: { type: 'string' },
              ref: { type: 'string' },
              verified_at: { type: 'string' },
              verifier_tool: { type: 'string' },
            },
            required: ['type'],
          },
          playbook_workstream: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['type', 'category', 'amount_cad', 'points_delta', 'description', 'verification'],
      },
    },
  },
];
