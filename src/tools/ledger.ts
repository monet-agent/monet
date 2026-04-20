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
export const ALLOWED_EARN_VERIFICATION: Record<string, string[]> = {
  ...TIER_A_EARN,
  ...TIER_B_EARN,
  ...TIER_C_EARN,
};

// Penalty categories recognized by the agent + the guardrail drift-check.
// tier_jargon is auto-applied by the heartbeat dispatcher when outbound
// text leaks internal tier/workstream jargon; see heartbeat_loop.ts.
export const PENALTY_CATEGORIES = [
  'hallucination',
  'broken_commitment',
  'unauth_spend',
  'reward_hack',
  'noise_update',
  'idle_heartbeat',
  'stale_continuity',
  'repeated_question',
  'tier_jargon',
] as const;

// Accepted note categories. Kept open (note entries aren't whitelisted in
// ledgerAppend), but this is the canonical list the drift-check compares
// against LEDGER.md's enum.
export const NOTE_CATEGORIES = ['proposal_sent', 'observation'] as const;

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

// Outcome-gated tier: numeric threshold AND a binary evidence predicate
// must BOTH hold. Gates are re-evaluated from the full ledger on every
// append — if the evidence disappears (e.g., a citation gets invalidated
// and reversed, or a revenue entry is reconciled out), the agent
// downgrades. Monotonic-up is explicitly NOT the policy.
function tierEvidenceHolds(tier: number, entries: LedgerEntry[]): boolean {
  const earns = entries.filter((e) => e.type === 'earn' && e.points_delta > 0);
  const nonSelf = (v: LedgerEntry['verification']) =>
    v.type !== 'self' && v.type !== 'none';

  if (tier <= 0) return true;

  // Tier 1: ≥1 verify_citation-true external citation AND ≥1 non-friend
  // follower/counterparty signal.
  if (tier >= 1) {
    const hasVerifiedCitation = entries.some(
      (e) => e.verification.verifier_tool === 'verify_citation' &&
        nonSelf(e.verification),
    );
    const FOLLOWER_CATEGORIES = new Set([
      'waitlist_signup_verified',
      'customer_interview_logged',
      'loi_received',
      'pricing_commit',
    ]);
    const hasNonFriendFollower = earns.some(
      (e) => FOLLOWER_CATEGORIES.has(e.category) && nonSelf(e.verification),
    );
    if (!hasVerifiedCitation || !hasNonFriendFollower) return false;
  }

  // Tier 2: first revenue_received / invoice_paid / paid_customer_acquired
  // entry, amount > 0, non-self counterparty.
  if (tier >= 2) {
    const REVENUE_CATEGORIES = new Set([
      'revenue_received', 'invoice_paid', 'paid_customer_acquired',
    ]);
    const hasRevenue = earns.some(
      (e) => REVENUE_CATEGORIES.has(e.category) &&
        e.amount_cad > 0 && nonSelf(e.verification),
    );
    if (!hasRevenue) return false;
  }

  // Tier 3: ≥$50 CAD Tier-A revenue in each of two consecutive calendar
  // months (reconcile-verified — i.e., verifier non-self).
  if (tier >= 3) {
    const REVENUE_CATEGORIES = new Set([
      'revenue_received', 'invoice_paid', 'paid_customer_acquired',
    ]);
    const byMonth = new Map<string, number>();
    for (const e of earns) {
      if (!REVENUE_CATEGORIES.has(e.category)) continue;
      if (!nonSelf(e.verification)) continue;
      const ym = e.ts.slice(0, 7); // YYYY-MM
      byMonth.set(ym, (byMonth.get(ym) ?? 0) + e.amount_cad);
    }
    const months = [...byMonth.keys()].sort();
    let hasTwoConsecutive = false;
    for (let i = 1; i < months.length; i++) {
      const prev = months[i - 1];
      const cur = months[i];
      if (!prev || !cur) continue;
      if ((byMonth.get(prev) ?? 0) >= 50 && (byMonth.get(cur) ?? 0) >= 50) {
        const [py, pm] = prev.split('-').map(Number);
        const [cy, cm] = cur.split('-').map(Number);
        if (py !== undefined && pm !== undefined && cy !== undefined && cm !== undefined) {
          const diff = (cy - py) * 12 + (cm - pm);
          if (diff === 1) { hasTwoConsecutive = true; break; }
        }
      }
    }
    if (!hasTwoConsecutive) return false;
  }

  return true;
}

function computeTier(points: number, entries: LedgerEntry[] = []): number {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (points >= (TIER_THRESHOLDS[i] ?? 0) && tierEvidenceHolds(i, entries)) {
      return i;
    }
  }
  return 0;
}

// KPI surfaced in the system prompt: count of earn entries in the last 7
// days whose verification.type is not "self" and not "none". Zero-this-week
// is the signal that demand-discovery is failing and monet should pick a
// demand action, not a build action.
export function getVerifiedEvents7d(): number {
  const entries = readAllEntries();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    if (e.type !== 'earn') return false;
    if (e.verification.type === 'self' || e.verification.type === 'none') return false;
    if (!e.ts) return false;
    const ts = new Date(e.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  }).length;
}

export function validateLedgerChain(): boolean {
  const entries = readAllEntries();
  return validateChain(entries as unknown as Array<Record<string, unknown>>);
}

// ── Derived-state views over the ledger ────────────────────────────────────
// These are pure functions over readAllEntries(). They exist so the heartbeat
// loop can inject canonical state into the system prompt each wake, instead
// of forcing monet to reconstruct it from MEMORY.md prose. All accept an
// optional nowMs for deterministic tests.

const PROPOSAL_ID_RE = /PROPOSAL_MSG_ID:\s*(\S+)/;

export interface PendingProposal {
  id: string;
  sent_ts: string;
  age_hours: number;
}

// A proposal_sent note entry with no downstream idea_validated earn whose
// notes reference the same PROPOSAL_MSG_ID.
export function getPendingProposals(nowMs: number = Date.now()): PendingProposal[] {
  const entries = readAllEntries();
  const validatedIds = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'earn' || e.category !== 'idea_validated') continue;
    const m = (e.notes ?? '').match(PROPOSAL_ID_RE);
    if (m?.[1]) validatedIds.add(m[1]);
  }
  const pending: PendingProposal[] = [];
  for (const e of entries) {
    if (e.type !== 'note' || e.category !== 'proposal_sent') continue;
    const m = (e.notes ?? '').match(PROPOSAL_ID_RE);
    const id = m?.[1];
    if (!id || validatedIds.has(id)) continue;
    // Legacy entries may lack `ts`. Skip them rather than crashing the sort.
    if (!e.ts) continue;
    const sentMs = new Date(e.ts).getTime();
    if (!Number.isFinite(sentMs)) continue;
    pending.push({
      id,
      sent_ts: e.ts,
      age_hours: Math.max(0, (nowMs - sentMs) / (60 * 60 * 1000)),
    });
  }
  pending.sort((a, b) => a.sent_ts.localeCompare(b.sent_ts));
  return pending;
}

export interface DemandDiscoveryState {
  interviews_this_week: number;
  proposals_this_week: number;
  escalation_required: boolean;
}

// Counts this-week customer_interview_logged earns and proposal_sent notes.
// Escalation fires when ≥3 interviews have been logged and zero proposals
// have gone out this week — the agent is sitting in discovery mode.
export function getDemandDiscoveryState(nowMs: number = Date.now()): DemandDiscoveryState {
  const entries = readAllEntries();
  const weekStartMs = new Date(startOfWeekISO()).getTime();
  void nowMs;
  let interviews = 0;
  let proposals = 0;
  for (const e of entries) {
    if (!e.ts) continue;
    const ts = new Date(e.ts).getTime();
    if (!Number.isFinite(ts) || ts < weekStartMs) continue;
    if (e.type === 'earn' && e.category === 'customer_interview_logged' && e.points_delta > 0) {
      interviews += 1;
    } else if (e.type === 'note' && e.category === 'proposal_sent') {
      proposals += 1;
    }
  }
  return {
    interviews_this_week: interviews,
    proposals_this_week: proposals,
    escalation_required: interviews >= 3 && proposals === 0,
  };
}

export interface ActiveValidatedProposal {
  id: string;
  validated_ts: string;
  age_hours: number;
  is_stale: boolean; // true if age_hours > 72
}

const MVP_OF_RE = /MVP_OF:\s*(\S+)/;
const DELIVERY_CATEGORIES: ReadonlySet<string> = new Set([
  'endpoint_live', 'revenue_received', 'invoice_paid', 'paid_customer_acquired',
]);

// idea_validated earns (last 21 days) whose PROPOSAL_MSG_ID has no matching
// delivery earn. Delivery is matched by an MVP_OF: <id> marker in the
// delivery earn's notes. Aged >72h with no delivery → is_stale=true.
export function getActiveValidatedProposals(nowMs: number = Date.now()): ActiveValidatedProposal[] {
  const entries = readAllEntries();
  const cutoffMs = nowMs - 21 * 24 * 60 * 60 * 1000;
  const deliveredIds = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'earn' || !DELIVERY_CATEGORIES.has(e.category)) continue;
    const m = (e.notes ?? '').match(MVP_OF_RE);
    if (m?.[1]) deliveredIds.add(m[1]);
  }
  const active: ActiveValidatedProposal[] = [];
  for (const e of entries) {
    if (e.type !== 'earn' || e.category !== 'idea_validated') continue;
    if (!e.ts) continue;
    const ts = new Date(e.ts).getTime();
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const m = (e.notes ?? '').match(PROPOSAL_ID_RE);
    const id = m?.[1];
    if (!id || deliveredIds.has(id)) continue;
    const ageHours = Math.max(0, (nowMs - ts) / (60 * 60 * 1000));
    active.push({
      id,
      validated_ts: e.ts,
      age_hours: ageHours,
      is_stale: ageHours > 72,
    });
  }
  active.sort((a, b) => a.validated_ts.localeCompare(b.validated_ts));
  return active;
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

    // Tightened counterparty_sig evidence gates. A ref URL alone is not proof
    // — the notes field must name the counterparty and quote their words so
    // the earn is auditable against a generic-pain false positive. Applies to
    // customer_interview_logged, pricing_commit, loi_received. idea_validated
    // has its own (stricter) gate below.
    const COUNTERPARTY_SIG_GATED: ReadonlySet<string> = new Set([
      'customer_interview_logged', 'pricing_commit', 'loi_received',
    ]);
    if (
      event.verification.type === 'counterparty_sig' &&
      COUNTERPARTY_SIG_GATED.has(event.category)
    ) {
      const notes = event.notes ?? '';
      const counterpartyMatch = notes.match(/COUNTERPARTY:\s*([^\n\r]+)/i);
      const rawCounterparty = counterpartyMatch?.[1]?.trim() ?? '';
      const counterpartyPlaceholders = new Set(['tbd', 'unknown', '?', 'n/a', 'na', 'none']);
      if (
        rawCounterparty.length < 2 ||
        counterpartyPlaceholders.has(rawCounterparty.toLowerCase())
      ) {
        throw new Error(
          `Earn "${event.category}" requires notes to include "COUNTERPARTY: <name>" with a real ` +
          `counterparty identifier (≥2 chars, not a placeholder). Got: "${rawCounterparty}". ` +
          `A URL ref alone is not evidence — a named counterparty is.`,
        );
      }
      const quoteMatch = notes.match(/QUOTE:\s*"([^"]{1,400})"/);
      const quotedText = quoteMatch?.[1]?.trim() ?? '';
      if (quotedText.length < 20) {
        throw new Error(
          `Earn "${event.category}" requires notes to include a direct-quoted counterparty ` +
          `statement: QUOTE: "<their exact words, ≥20 chars>". Got quote of length ${quotedText.length}. ` +
          `Single-word quotes like "interested" are not pain evidence.`,
        );
      }
      if (event.category === 'pricing_commit') {
        if (!/PRICE:\s*\$\s*[0-9]/.test(notes)) {
          throw new Error(
            `Earn "pricing_commit" requires notes to include "PRICE: $<amount>" naming the dollar ` +
            `figure the counterparty committed to. Without a stated price, this is a pain quote, ` +
            `not a pricing commit — log it as customer_interview_logged instead.`,
          );
        }
      }
      if (event.category === 'loi_received') {
        if (!/LOI_(HASH|URL):\s*\S+/i.test(notes)) {
          throw new Error(
            `Earn "loi_received" requires notes to include either "LOI_HASH: <sha256>" or ` +
            `"LOI_URL: <url>" referencing the signed LOI artifact. Without a hash/URL, this is ` +
            `a pain quote, not an LOI.`,
          );
        }
      }
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

  // Stamp ts server-side if the caller (often the LLM) omitted it. Missing
  // ts silently broke getVerifiedEvents7d and crashed derived-state sorts,
  // so treat it as a harness guarantee rather than caller discipline.
  const stampedEvent = event.ts ? event : { ...event, ts: new Date().toISOString() };
  const partial = { ...stampedEvent, seq, prev_hash } as Record<string, unknown>;
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
  const allEntries = readAllEntries();
  const newTier = computeTier(state.total_points, allEntries);
  if (newTier !== state.tier) {
    const direction = newTier > state.tier ? 'unlocked' : 'downgraded';
    console.log(`[ledger] Tier ${direction}: ${state.tier} → ${newTier}`);
    state.tier = newTier;
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
