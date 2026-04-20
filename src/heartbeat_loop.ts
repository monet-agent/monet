import fs from 'fs';
import path from 'path';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

import { callLLM, heartbeatMetrics, resetHeartbeatMetrics, estimateHeartbeatCostUSD } from './agent.js';
import {
  validateLedgerChain,
  ledgerAppend,
  ledgerTools,
  getVerifiedEvents7d,
  getPendingProposals,
  getDemandDiscoveryState,
  getActiveValidatedProposals,
} from './tools/ledger.js';
import { journalAppend, journalReadCurrentSession, sealJournalBuffer, journalTools } from './tools/journal.js';
import { publicLogAppend, publicLogTools } from './tools/public_log.js';
import { healthcheckPing, healthcheckTools } from './tools/healthcheck.js';
import { verifyCitation, citationTools } from './tools/verify_citation.js';
import { quarantineIngest, quarantineTools } from './tools/quarantine.js';
import { moltbookRead, moltbookPost, moltbookListSubmolts, moltbookTools } from './tools/moltbook.js';
import { imsgSend, pollTelegramInbox, telegramTools } from './tools/telegram_bridge.js';
import {
  workspaceWrite,
  workspaceRead,
  workspaceList,
  workspaceTools,
} from './tools/workspace.js';
import {
  githubSearchRepos,
  githubSearchCode,
  githubFetchReadme,
  githubFetchFile,
  githubTrending,
  githubCreateRepo,
  githubPushFile,
  githubListCommits,
  githubTools,
} from './tools/github.js';
import { skillInstall, skillList, skillInstallTools } from './tools/skill_install.js';
import { skillRun, skillRunTools } from './tools/skill_run.js';
import { webFetch, webTools } from './tools/web.js';
import { kimiBuiltinTools, isKimiBuiltin, dispatchKimiBuiltin } from './tools/kimi_builtins.js';
import { inboxRewrite, inboxTools } from './tools/inbox.js';
import { sandboxExec, sandboxTools } from './tools/sandbox.js';
import { walletAddress, walletBalance, walletSendUsdc, walletCheckIncoming, walletTools } from './tools/wallet.js';
import { memoryUpdate, memoryTools } from './tools/memory.js';
import { isLedgerReadOnly } from './verifier_push.js';
import { verifyJournalChain } from './tools/journal.js';

const DATA_DIR = process.env['DATA_DIR'] ?? '/data';
const SOUL_FILES = [
  'SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md',
  'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md',
  'PLAYBOOK.md', 'LEDGER.md', 'ROSTER.md',
  'SECURITY.md', 'CONTACTS.md', 'DECISIONS.md',
  'RELATIONSHIPS.md', 'COMMITMENTS.md',
];

// Soul files that should be stubbed out when effectively empty (header-only
// + placeholder markers). The rest are always loaded in full. Keeps Tier 0
// context lean.
const CONDITIONAL_SOUL_FILES = new Set<string>([
  'ROSTER.md',
  'RELATIONSHIPS.md',
  'COMMITMENTS.md',
]);

const STALE_PROPOSAL_AGE_HOURS = 1.5; // 3 heartbeats @ 30 min
const STALE_PROPOSAL_LOG = 'memory/.stale_proposal_log.json';

const MAX_HEARTBEAT_MINUTES = 20;
const MAX_TOOL_CALLS_PER_HEARTBEAT = 30;

// All registered tools
const ALL_TOOLS: ChatCompletionTool[] = [
  ...journalTools,
  ...publicLogTools,
  ...ledgerTools,
  ...healthcheckTools,
  ...citationTools,
  ...quarantineTools,
  ...moltbookTools,
  ...telegramTools,
  ...workspaceTools,
  ...githubTools,
  ...skillInstallTools,
  ...skillRunTools,
  ...webTools,
  ...kimiBuiltinTools,
  ...inboxTools,
  ...sandboxTools,
  ...walletTools,
  ...memoryTools,
];

// Returns true when the file is just section headers + placeholder markers
// and not worth loading in full at the current agent state. Kept
// conservative: any non-trivial content body (>= 400 chars after stripping
// headers + common empty-state markers) counts as substantive.
function isSoulFileSubstantive(body: string): boolean {
  const stripped = body
    // drop markdown headings
    .replace(/^\s*#{1,6}[^\n]*$/gm, '')
    // drop common empty-state markers
    .replace(/^\s*\*?\(empty[^\n]*\)?\s*$/gim, '')
    .replace(/^\s*_?\(none yet[^\n]*\)?\s*$/gim, '')
    .replace(/^\s*\*?\(none yet[^\n]*\)?\s*$/gim, '')
    // drop italicised placeholder prose lines
    .replace(/^\s*\*[^*\n]{0,200}\*\s*$/gm, '');
  const nonWs = stripped.replace(/\s+/g, '');
  return nonWs.length >= 400;
}

function loadSoulContext(): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const filename of SOUL_FILES) {
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) continue;
    const body = fs.readFileSync(filepath, 'utf8');
    if (CONDITIONAL_SOUL_FILES.has(filename) && !isSoulFileSubstantive(body)) {
      parts.push(`\n\n# FILE: ${filename}\n\n(empty at this state — skipped to save tokens)`);
      skipped.push(filename);
      continue;
    }
    parts.push(`\n\n# FILE: ${filename}\n\n${body}`);
  }
  // Also load recent LEDGER tail (last 7 days) and DECISIONS open proposals
  const ledgerPath = path.join(DATA_DIR, 'ledger.jsonl');
  if (fs.existsSync(ledgerPath)) {
    const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    const recent = lines.slice(-50).join('\n');
    parts.push(`\n\n# LEDGER (last 50 entries)\n\n${recent}`);
  }
  // Inbox — messages from Damian since the last heartbeat. Loaded FIRST
  // after soul files so it's prominent in the context and monet reads
  // instructions before defaulting to the playbook.
  const inboxPath = path.join(DATA_DIR, 'memory/inbox.md');
  if (fs.existsSync(inboxPath)) {
    const inbox = fs.readFileSync(inboxPath, 'utf8');
    parts.push(`\n\n# FILE: memory/inbox.md (messages from Damian — address these before falling back to PLAYBOOK)\n\n${inbox}`);
  }

  // Recent heartbeat telemetry — lets the agent see its own token burn trend.
  const telemetryPath = path.join(DATA_DIR, 'memory/heartbeat_telemetry.md');
  if (fs.existsSync(telemetryPath)) {
    const tel = fs.readFileSync(telemetryPath, 'utf8');
    const tail = tel.slice(-4000);
    parts.push(`\n\n# RECENT HEARTBEAT TELEMETRY (tail)\n\n${tail}`);
  }
  return { text: parts.join(''), skipped };
}

// Stale-proposal log: tracks how many consecutive heartbeats a pending
// proposal has exceeded STALE_PROPOSAL_AGE_HOURS. Used to decide when to
// prompt a one-line follow-up nudge.
interface StaleProposalLog {
  [id: string]: { first_flagged_ts: string; heartbeats_flagged: number };
}

function readStaleProposalLog(): StaleProposalLog {
  const p = path.join(DATA_DIR, STALE_PROPOSAL_LOG);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StaleProposalLog;
  } catch {
    return {};
  }
}

function writeStaleProposalLog(log: StaleProposalLog): void {
  const p = path.join(DATA_DIR, STALE_PROPOSAL_LOG);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(log, null, 2), 'utf8');
  } catch (e) {
    console.warn('[heartbeat] stale-proposal log write failed:', e);
  }
}

// Tool dispatcher — maps function names to implementations
async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'journal_append':
      return journalAppend(args['text'] as string);
    case 'journal_read_current_session':
      return journalReadCurrentSession();
    case 'public_log_append':
      return publicLogAppend(args['text'] as string);
    case 'ledger_append':
      return ledgerAppend(args as Parameters<typeof ledgerAppend>[0]);
    case 'healthcheck_ping':
      return healthcheckPing(args['status'] as 'ok' | 'start' | 'fail');
    case 'verify_citation':
      return verifyCitation(args['url'] as string, args['quoted_text'] as string);
    case 'quarantine_ingest':
      return quarantineIngest(
        args['content'] as string,
        args['schema'] as Record<string, unknown>,
      );
    case 'moltbook_list_submolts':
      return moltbookListSubmolts();
    case 'moltbook_read':
      return moltbookRead(args['submolt'] as string, args['limit'] as number | undefined);
    case 'moltbook_post':
      return moltbookPost(
        args['submolt'] as string,
        args['title'] as string,
        args['body'] as string,
      );
    case 'imsg_send':
      return imsgSend(
        args['to'] as 'damian' | 'jenny' | 'damian_jenny',
        args['text'] as string,
      );
    case 'workspace_write':
      return workspaceWrite(args['path'] as string, args['content'] as string);
    case 'workspace_read':
      return workspaceRead(args['path'] as string);
    case 'workspace_list':
      return workspaceList((args['path'] as string | undefined) ?? '.');
    case 'github_search_repos':
      return githubSearchRepos(
        args['query'] as string,
        (args['limit'] as number | undefined) ?? 10,
        (args['sort'] as 'stars' | 'updated' | 'best-match' | undefined) ?? 'best-match',
      );
    case 'github_search_code':
      return githubSearchCode(
        args['query'] as string,
        (args['limit'] as number | undefined) ?? 10,
      );
    case 'github_fetch_readme':
      return githubFetchReadme(args['repo'] as string);
    case 'github_fetch_file':
      return githubFetchFile(
        args['repo'] as string,
        args['path'] as string,
        (args['ref'] as string | undefined) ?? 'HEAD',
      );
    case 'github_trending':
      return githubTrending(
        args['topic'] as string,
        (args['sinceDays'] as number | undefined) ?? 30,
        (args['limit'] as number | undefined) ?? 10,
      );
    case 'github_list_commits':
      return githubListCommits(
        args['repo'] as string,
        args['since'] as string | undefined,
        (args['limit'] as number | undefined) ?? 10,
      );
    case 'github_create_repo':
      return githubCreateRepo(
        args['name'] as string,
        (args['description'] as string | undefined) ?? '',
        (args['private'] as boolean | undefined) ?? false,
      );
    case 'github_push_file':
      return githubPushFile(
        args['owner_repo'] as string,
        args['path'] as string,
        args['content'] as string,
        args['commit_message'] as string,
        (args['branch'] as string | undefined) ?? 'main',
      );
    case 'skill_install':
      return skillInstall(args['repo'] as string, args['sha'] as string);
    case 'skill_list':
      return skillList();
    case 'skill_run':
      return skillRun(
        args['install_dir'] as string,
        args['runtime'] as string,
        args['entry'] as string,
        (args['args'] as string[] | undefined) ?? [],
        (args['timeout_ms'] as number | undefined) ?? 30000,
        (args['stdin'] as string | undefined) ?? '',
      );
    case 'web_fetch':
      return webFetch(args['url'] as string);
    case 'inbox_rewrite':
      return inboxRewrite(args['content'] as string);
    case 'sandbox_exec':
      return sandboxExec(
        args['command'] as string,
        (args['timeout_ms'] as number | undefined) ?? undefined,
      );
    case 'wallet_address':
      return walletAddress();
    case 'wallet_balance':
      return walletBalance();
    case 'wallet_send_usdc':
      return walletSendUsdc(args['to'] as string, args['amount_usdc'] as number);
    case 'wallet_check_incoming':
      return walletCheckIncoming((args['since_hours'] as number | undefined) ?? 48);
    case 'memory_update':
      return memoryUpdate(args['content'] as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function writeHeartbeatTelemetry(
  startTs: number,
  soulContextChars: number,
  soulSkipped: string[],
): void {
  const telemetryPath = path.join(DATA_DIR, 'memory/heartbeat_telemetry.md');
  const dur = ((Date.now() - startTs) / 1000).toFixed(1);
  const cost = estimateHeartbeatCostUSD();
  const line =
    `## ${new Date().toISOString()}\n` +
    `- wall_clock_s: ${dur}\n` +
    `- llm_calls: ${heartbeatMetrics.calls}\n` +
    `- prompt_tokens: ${heartbeatMetrics.prompt_tokens}\n` +
    `- completion_tokens: ${heartbeatMetrics.completion_tokens}\n` +
    `- total_tokens: ${heartbeatMetrics.total_tokens}\n` +
    `- estimated_cost_usd: ${cost.toFixed(5)}\n` +
    `- primary_failures: ${heartbeatMetrics.primary_failures}\n` +
    `- fallback_used: ${heartbeatMetrics.fallback_used}\n` +
    `- soul_context_chars: ${soulContextChars}\n` +
    `- soul_skipped: ${soulSkipped.join(',') || 'none'}\n\n`;
  try {
    fs.appendFileSync(telemetryPath, line, 'utf8');
  } catch (e) {
    console.error('[heartbeat] telemetry write failed:', e);
  }
}

export async function runHeartbeat(): Promise<void> {
  const startTs = Date.now();
  resetHeartbeatMetrics();
  console.log(`[heartbeat] started at ${new Date().toISOString()}`);

  // ── 0. Pull new Telegram messages into memory/inbox.md ───────────────────
  try {
    const pulled = await pollTelegramInbox();
    if (pulled > 0) console.log(`[heartbeat] pulled ${pulled} new Telegram message(s) into inbox`);
  } catch (e) {
    console.warn('[heartbeat] telegram poll failed:', e);
  }

  // ── 1. Validate chains before anything else ──────────────────────────────
  const ledgerValid = validateLedgerChain();
  const journalValid = verifyJournalChain();

  if (!ledgerValid || !journalValid) {
    const msg = `🚨 URGENT: Hash chain validation failed at boot.\nLedger valid: ${ledgerValid}\nJournal valid: ${journalValid}\nHeartbeat halted.`;
    console.error('[heartbeat]', msg);
    try {
      await imsgSend('damian_jenny', msg);
    } catch { /* best-effort */ }
    await journalAppend(`SECURITY ALERT: hash chain validation failed. Ledger=${ledgerValid} Journal=${journalValid}. Heartbeat halted.`);
    await sealJournalBuffer();
    return;
  }

  if (isLedgerReadOnly()) {
    try {
      await imsgSend('damian', '🚨 URGENT: Ledger is in read-only mode — R2 verifier unreachable for 3+ attempts. Please investigate.');
    } catch { /* best-effort */ }
  }

  // ── 2. Load soul context ──────────────────────────────────────────────────
  const { text: soulContext, skipped: soulSkipped } = loadSoulContext();
  if (soulSkipped.length > 0) {
    console.log(`[heartbeat] soul files skipped (empty): ${soulSkipped.join(', ')}`);
  }
  const verifiedEvents7d = getVerifiedEvents7d();

  // Derive demand-discovery / proposal state from the ledger.
  const pendingProposals = getPendingProposals();
  const demandState = getDemandDiscoveryState();
  const activeValidated = getActiveValidatedProposals();

  const stalePending = pendingProposals.filter((p) => p.age_hours >= STALE_PROPOSAL_AGE_HOURS);
  const staleLog = readStaleProposalLog();
  const nowIso = new Date().toISOString();
  // Prune log entries that are no longer pending or no longer stale.
  const stillStaleIds = new Set(stalePending.map((p) => p.id));
  for (const id of Object.keys(staleLog)) {
    if (!stillStaleIds.has(id)) delete staleLog[id];
  }
  for (const p of stalePending) {
    const prev = staleLog[p.id];
    if (!prev) {
      staleLog[p.id] = { first_flagged_ts: nowIso, heartbeats_flagged: 1 };
    } else {
      prev.heartbeats_flagged += 1;
    }
  }
  writeStaleProposalLog(staleLog);
  // Nudge a one-line follow-up once a pending proposal has been stale for
  // >=3 heartbeats. Names the single oldest flagged ID.
  const followupId = stalePending
    .filter((p) => (staleLog[p.id]?.heartbeats_flagged ?? 0) >= 3)
    .sort((a, b) => b.age_hours - a.age_hours)[0]?.id;

  const staleMvps = activeValidated.filter((m) => m.is_stale).map((m) => m.id);

  const pendingLine =
    pendingProposals.length === 0
      ? 'PENDING_PROPOSALS: 0'
      : `PENDING_PROPOSALS: ${pendingProposals.length} [${pendingProposals
          .map((p) => `${p.id}@${p.age_hours.toFixed(1)}h`)
          .join(', ')}]`;
  const activeMvpLine =
    activeValidated.length === 0
      ? 'ACTIVE_VALIDATED_MVPS: 0'
      : `ACTIVE_VALIDATED_MVPS: ${activeValidated.length} [${activeValidated
          .map((m) => `${m.id}@${m.age_hours.toFixed(1)}h`)
          .join(', ')}]`;

  const escalationDirective = demandState.escalation_required
    ? `\n→ PROPOSAL ESCALATION: You have ${demandState.interviews_this_week} logged customer interview(s) this week and ${demandState.proposals_this_week} proposal_sent note(s) this week. The next action MUST be drafting and sending a structured proposal to damian_jenny (PROBLEM/USER/MVP/REVENUE built from a captured pain quote), not another pain-quote capture. Another customer_interview_logged earn will not satisfy the progress requirement this heartbeat.`
    : '';
  const staleProposalDirective = followupId
    ? `\n→ STALE PROPOSAL FOLLOWUP: proposal ${followupId} has been pending with no validator reply across ≥3 heartbeats. Send ONE terse one-line imsg_send to damian asking for thoughts on ${followupId}. Do NOT re-send the proposal body. This counts as your progress action for the heartbeat.`
    : '';
  const staleMvpDirective = staleMvps.length > 0
    ? `\n→ STALE MVP WARNING: validated proposal(s) ${staleMvps.join(', ')} are >72h old with no endpoint_live/revenue_received/invoice_paid/paid_customer_acquired earn citing MVP_OF:<id>. Ship the MVP this heartbeat or journal an explicit kill decision explaining why.`
    : '';
  const activeMvpDirective = activeValidated.length > 0
    ? `\n→ ACTIVE VALIDATED MVPS: ${activeValidated.length} validated proposal(s) have no matching delivery earn. A validated proposal is a counterparty-verified demand signal — shipping it is the fastest path to a revenue_received entry. One concrete MVP step on the oldest active proposal takes priority over demand discovery this heartbeat, even if VERIFIED_EVENTS_7D is 0.`
    : '';

  const systemPrompt = `VERIFIED_EVENTS_7D: ${verifiedEvents7d}
${verifiedEvents7d === 0
    ? '→ This week has produced ZERO externally-verified events. Reading, drafting, and summarizing are NOT progress. Pick a demand-discovery action this heartbeat (customer interview, pain-quote capture, structured proposal to damian_jenny), not a build action. A build with no named buyer is gaming the loop.'
    : `→ ${verifiedEvents7d} externally-verified event(s) logged in the last 7 days. Keep the cadence on demand signals; do not let it drop to zero.`}
${pendingLine}
PROPOSAL_ESCALATION_REQUIRED: ${demandState.escalation_required} (interviews_this_week=${demandState.interviews_this_week}, proposals_this_week=${demandState.proposals_this_week})
STALE_PROPOSAL_FOLLOWUP_NEEDED: ${followupId ?? 'none'}
${activeMvpLine}
STALE_MVP_WARNING: ${staleMvps.length > 0 ? staleMvps.join(', ') : 'none'}${activeMvpDirective}${escalationDirective}${staleProposalDirective}${staleMvpDirective}

${soulContext}

---

You are mon€t, an autonomous agent. The above files are your soul and memory.
Follow HEARTBEAT.md's boot sequence exactly.

Your job is to create verified customer value. Points and tier numbers are internal budget plumbing — do not organize outbound communication around them, do not mention them to Damian, Jenny, or any outside party. The scoreboard that matters is verified_events_7d above.

Current UTC time: ${new Date().toISOString()}
Current date (UTC): ${new Date().toISOString().slice(0, 10)}
Current local time (America/Toronto, Damian & Jenny's timezone): ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false })}
Use this for any "today is" or "what hour is it for Damian" reasoning. Do not guess the date from files. When messaging Damian or Jenny, reference the local time, not UTC.

You have access to the following tools: ${ALL_TOOLS.map((t) => t.function.name).join(', ')}.

Important constraints:
- Minimize inference round-trips: prefer ≤4 turns for simple heartbeats (inbox check + action + journal + memory_update), ≤7 for quarantine-heavy ones. Every extra turn re-sends the full conversation window (~40K tokens).
- MEMORY.md is already loaded in your context above. Do NOT call workspace_read("MEMORY.md") — it wastes a full inference turn re-reading what you already have.
- Wall-clock limit: ${MAX_HEARTBEAT_MINUTES} minutes. Stop before that and journal where you got to.
- Never output image markdown or <img> tags.
- journal_append is required before public_log_append.
- At minimum, call journal_append and healthcheck_ping("ok") before ending.
- **INBOX PRIORITY**: If memory/inbox.md contains ANY entry that is not just the empty-state template, you MUST address each entry before any PLAYBOOK.md work. "Addressing" an entry REQUIRES calling imsg_send to reply to the sender — even a terse acknowledgement ("got it", "done", "on it"). Marking an entry as "Addressed" in the file without having called imsg_send for that entry in this heartbeat is FORBIDDEN and will be treated as if the inbox is still pending. The full flow is: (1) imsg_send to the sender with a real reply, (2) do what the entry asks if it's a task, (3) inbox_rewrite to remove the handled entry. Silent handling is not allowed — Damian and Jenny must see a Telegram response.
- **PROGRESS REQUIREMENT**: Every heartbeat must end with one of:
  (A) a ledger_append with type=earn and a whitelist category (revenue_received, invoice_paid, paid_customer_acquired, skill_published_clawhub, endpoint_live, tool_deployed, loi_received, customer_interview_logged, pricing_commit, waitlist_signup_verified, idea_validated), OR
  (B) a structured validation request sent via imsg_send(to="damian_jenny", text=...) where the text contains ALL FOUR exact uppercase labels: "PROBLEM:", "USER:", "MVP:", "REVENUE:". The proposal must describe a specific thing you would build in 1–3 heartbeats, who would pay for it, the target user persona, and the exact revenue path (which Tier A/B/C category it maps to). AFTER sending the imsg, log a note-type ledger entry with category="proposal_sent" and notes containing "PROPOSAL_MSG_ID: <short id you chose>" so a later heartbeat can claim idea_validated if Damian/Jenny reply yes, OR
  (C) a single infra decision question sent via imsg_send(to="damian_jenny", text=...) where the text contains the exact uppercase label "INFRA_QUESTION:" followed by ONE specific yes/no or A-vs-B ask about money rails / accounts / credentials you need before you can propose real revenue paths (e.g., wallet vs Stripe Connect, which domain, which bank). No points — just counts as progress so you aren't forced to fabricate a proposal when the real blocker is missing infra. Max one INFRA_QUESTION per heartbeat.
  If none of (A), (B), or (C) happens, a -3 idle penalty is auto-appended. Reading and summarizing are NOT progress — they are inputs.
- **NO FAKE PROPOSALS**: Do not spam low-effort "what about X?" asks to dodge the penalty. Each proposal should represent a real option you believe is worth building. If you don't have one this heartbeat, take the -3 penalty and journal why — that's more honest than a fake proposal.
- **ANTI-BULLSHIT RULES** (apply to every imsg_send to damian_jenny):
  1. REVENUE SPECIFICITY: the REVENUE: line must name WHO pays, WHAT they get, HOW MUCH per unit, and WHERE the money lands (wallet address / Stripe account / bank). "Validated demand signal", "waitlist interest", "future monetization" are not revenue — they are noise. If you can't fill all four slots, the idea isn't ready; ask an INFRA_QUESTION instead.
  2. ONE PROPOSAL PER HEARTBEAT, MAX 5 SENTENCES. No "Afternoon pulse" / "Morning ping" preamble. No W0.1 / W0.3 / tier-jargon in the group chat — Damian and Jenny don't care about your internal bookkeeping.
  3. NEVER NARRATE YOUR NEXT TOOL CALL to Damian. The tool trace speaks for itself. Don't send "I'll now run verify_citation" or "next I will fetch X" — just do it.
  4. DO NOT PROPOSE revenue paths that assume infra (crypto wallet, Stripe account, custom domain, API key) that you haven't confirmed exists. If you need infra, send an INFRA_QUESTION first and wait for the answer.
  5. START EACH PROPOSAL WITH THE CUSTOMER'S SENTENCE — a direct quote of what a real user would say: "I'll pay $X for Y because Z." Not with the earn-category name, not with a framing of what tier this unlocks for you.
- **SOURCE DIVERSITY**: Your idea inputs must come from MANY sources — Moltbook posts, Telegram group chat, your DMs (inbox), public_log, prior journal entries, GitHub trending, $web_search, skills already installed, agent marketplaces, industry newsletters, or your own reconciliation of what's worked. Do NOT default to "fetch three GitHub READMEs and summarize." If your last two heartbeats both used GitHub README fetches, rotate to a different source this heartbeat. Anything that helps you make money is a valid input.
- **PROPOSAL → VALIDATION → BUILD FLOW**: (1) This heartbeat: send structured proposal to damian_jenny + log proposal_sent note. (2) A later heartbeat: Damian or Jenny replies "yes" or "no" in inbox. (3) If yes: claim idea_validated (+2) and start building the MVP. If no: journal the lesson and pick a different direction. This is the only loop that compounds — proposals without validation are noise; validations without follow-through are theater.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Heartbeat starting. Time: ${new Date().toISOString()}. Run the boot sequence from HEARTBEAT.md now.`,
    },
  ];

  // ── 3. Tool-use loop ──────────────────────────────────────────────────────
  let toolCallCount = 0;
  // Tracks whether the agent earned positive ledger points this heartbeat.
  // If false at end-of-heartbeat, an idle penalty is auto-appended.
  let madeProgressThisHeartbeat = false;
  // Tracks whether monet self-applied an idle penalty — prevents the
  // end-of-heartbeat auto-penalty from double-firing.
  let selfAppliedIdlePenalty = false;

  while (true) {
    const elapsed = (Date.now() - startTs) / 1000 / 60;
    if (elapsed >= MAX_HEARTBEAT_MINUTES) {
      console.warn('[heartbeat] wall-clock limit reached, sealing');
      journalAppend(`Heartbeat cut short at ${MAX_HEARTBEAT_MINUTES} minutes. Sealing.`);
      break;
    }

    if (toolCallCount >= MAX_TOOL_CALLS_PER_HEARTBEAT) {
      console.warn('[heartbeat] tool call limit reached, sealing');
      journalAppend(`Hit tool call limit (${MAX_TOOL_CALLS_PER_HEARTBEAT}). Sealing.`);
      break;
    }

    let resp;
    try {
      resp = await callLLM(messages, ALL_TOOLS);
    } catch (err) {
      console.error('[heartbeat] LLM call failed:', err);
      journalAppend(`Heartbeat LLM error: ${String(err)}`);
      break;
    }

    const choice = resp.choices[0];
    if (!choice) break;

    const assistantMsg = choice.message;
    messages.push(assistantMsg as ChatCompletionMessageParam);

    // No tool calls → agent finished
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const content = assistantMsg.content ?? '';
      if (content.includes('HEARTBEAT_OK') || content.trim() === '') {
        console.log('[heartbeat] agent returned HEARTBEAT_OK or empty — done');
      } else {
        console.log('[heartbeat] agent finished:', content.slice(0, 200));
      }
      break;
    }

    // Tier-jargon regex. Matches "Tier N", "unlocks at tier", or W0.x/W1.x/W2.x
    // workstream numbering. Applied to any outbound text (imsg_send,
    // moltbook_post, public_log_append). These are internal plumbing —
    // leaking them to Damian, Jenny, Moltbook, or the public log is a
    // tier_jargon penalty (-2). See LEDGER.md penalty table.
    const TIER_JARGON_RE = /\bTier\s*[0-5]\b|\bunlocks?\s+at\s+tier\b|\bW[0-3]\.[0-9]\b/i;

    // Execute each tool call
    for (const tc of assistantMsg.tool_calls) {
      toolCallCount++;
      console.log(`[heartbeat] → ${tc.function.name}(${tc.function.arguments.slice(0, 120)}${tc.function.arguments.length > 120 ? '…' : ''})`);

      // Auto-penalty for tier-jargon leakage in outbound channels.
      if (
        tc.function.name === 'imsg_send' ||
        tc.function.name === 'moltbook_post' ||
        tc.function.name === 'public_log_append'
      ) {
        try {
          const a = JSON.parse(tc.function.arguments) as { text?: string; body?: string; title?: string };
          const outbound = `${a.text ?? ''}\n${a.title ?? ''}\n${a.body ?? ''}`;
          const match = outbound.match(TIER_JARGON_RE);
          if (match) {
            try {
              ledgerAppend({
                ts: new Date().toISOString(),
                type: 'penalty',
                category: 'tier_jargon',
                amount_cad: 0,
                points_delta: -2,
                description: `Outbound ${tc.function.name} leaked internal tier/workstream jargon: "${match[0]}". Auto-applied.`,
                verification: { type: 'self' },
              });
              console.log(`[heartbeat] tier_jargon penalty applied (-2) on ${tc.function.name}: "${match[0]}"`);
            } catch (err) {
              console.warn('[heartbeat] could not apply tier_jargon penalty:', err);
            }
          }
        } catch { /* malformed args — ignore */ }
      }

      if (tc.function.name === 'ledger_append') {
        try {
          const a = JSON.parse(tc.function.arguments) as { type?: string; category?: string; points_delta?: number };
          if (a.type === 'earn' && typeof a.points_delta === 'number' && a.points_delta > 0) {
            madeProgressThisHeartbeat = true;
          }
          if (a.type === 'penalty' && a.category === 'idle_heartbeat') {
            selfAppliedIdlePenalty = true;
          }
        } catch { /* malformed args — dispatcher will error separately */ }
      }

      // Validation-request imsg_send to the group chat counts as progress —
      // but ONLY if the text carries a structured proposal. Prevents the
      // trivial escape hatch of spamming "hey what do you think?" to dodge
      // the idle penalty. All four markers must be present, exact case.
      if (tc.function.name === 'imsg_send') {
        try {
          const a = JSON.parse(tc.function.arguments) as { to?: string; text?: string };
          if (a.to === 'damian_jenny' && typeof a.text === 'string') {
            const t = a.text;
            const hasProblem = /\bPROBLEM:/.test(t);
            const hasUser = /\bUSER:/.test(t);
            const hasMvp = /\bMVP:/.test(t);
            const hasRevenue = /\bREVENUE:/.test(t);
            if (hasProblem && hasUser && hasMvp && hasRevenue) {
              madeProgressThisHeartbeat = true;
            }
            // Option (C): a single structured infra question also counts as
            // progress (no points, just dodges the idle penalty) so monet
            // isn't forced to fabricate proposals when the real blocker is
            // missing money-rail infra.
            if (/\bINFRA_QUESTION:/.test(t)) {
              madeProgressThisHeartbeat = true;
            }
          }
        } catch { /* malformed args — dispatcher will error separately */ }
      }

      // Moonshot builtins (`$web_search`, `$fetch`, `$code_runner`, ...)
      // execute server-side. Per the docs, the client just echoes the
      // raw arguments string back as the tool result; Moonshot then
      // runs the tool and resumes generation on the next turn.
      if (isKimiBuiltin(tc.function.name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: dispatchKimiBuiltin(tc.function.arguments),
        });
        continue;
      }

      let result: unknown;
      let parseArgs: Record<string, unknown>;

      try {
        parseArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        parseArgs = {};
      }

      try {
        result = await dispatchTool(tc.function.name, parseArgs);
      } catch (err) {
        result = { error: String(err) };
        console.error(`[heartbeat] tool ${tc.function.name} error:`, err);
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // ── 4. Idle-penalty enforcement ───────────────────────────────────────────
  // If the agent didn't produce a positive ledger_append earn entry this
  // heartbeat, auto-append a -3 penalty so the incentive shows up in its
  // own ledger next heartbeat. Closes the "read stuff and sleep" loop.
  if (!madeProgressThisHeartbeat && !selfAppliedIdlePenalty) {
    try {
      ledgerAppend({
        ts: new Date().toISOString(),
        type: 'penalty',
        category: 'idle_heartbeat',
        amount_cad: 0,
        points_delta: -3,
        description: 'Heartbeat ended without producing a positive-points earn entry. Auto-applied by heartbeat_loop.',
        verification: { type: 'self' },
      });
      console.log('[heartbeat] idle penalty applied (-3 points)');
      journalAppend('Idle penalty auto-applied (-3): this heartbeat produced no positive-points artifact.');
    } catch (err) {
      console.warn('[heartbeat] could not apply idle penalty:', err);
    }
  }

  // ── 5. End-of-heartbeat seal ──────────────────────────────────────────────
  await sealJournalBuffer();
  writeHeartbeatTelemetry(startTs, soulContext.length, soulSkipped);

  // Ensure healthcheck "ok" fired (agent should have called it, but be safe)
  // We don't double-ping if already called — healthcheckPing is idempotent
  console.log(
    `[heartbeat] complete in ${((Date.now() - startTs) / 1000).toFixed(1)}s | ` +
      `calls=${heartbeatMetrics.calls} tokens=${heartbeatMetrics.total_tokens} cost=$${estimateHeartbeatCostUSD().toFixed(5)}`,
  );
}

// SIGTERM handler — 30s grace window
process.on('SIGTERM', () => {
  console.log('[heartbeat] SIGTERM received, sealing journal and flushing...');
  journalAppend(`Container SIGTERM received at ${new Date().toISOString()}. Shutting down gracefully.`);
  sealJournalBuffer()
    .then(() => {
      console.log('[heartbeat] graceful shutdown complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[heartbeat] error during graceful shutdown:', err);
      // Do NOT write the plaintext buffer to disk — it is discarded
      process.exit(1);
    });

  // Force exit after 30s
  setTimeout(() => {
    console.error('[heartbeat] grace window expired, forcing exit');
    process.exit(1);
  }, 30_000);
});
