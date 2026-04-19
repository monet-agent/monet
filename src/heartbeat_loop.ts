import fs from 'fs';
import path from 'path';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

import { callLLM, heartbeatMetrics, resetHeartbeatMetrics, estimateHeartbeatCostUSD } from './agent.js';
import { validateLedgerChain, ledgerAppend, ledgerTools } from './tools/ledger.js';
import { journalAppend, journalReadCurrentSession, sealJournalBuffer, journalTools } from './tools/journal.js';
import { publicLogAppend, publicLogTools } from './tools/public_log.js';
import { healthcheckPing, healthcheckTools } from './tools/healthcheck.js';
import { verifyCitation, citationTools } from './tools/verify_citation.js';
import { quarantineIngest, quarantineTools } from './tools/quarantine.js';
import { moltbookRead, moltbookPost, moltbookTools } from './tools/moltbook.js';
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
  githubTools,
} from './tools/github.js';
import { skillInstall, skillList, skillInstallTools } from './tools/skill_install.js';
import { skillRun, skillRunTools } from './tools/skill_run.js';
import { webFetch, webTools } from './tools/web.js';
import { kimiBuiltinTools, isKimiBuiltin, dispatchKimiBuiltin } from './tools/kimi_builtins.js';
import { inboxRewrite, inboxTools } from './tools/inbox.js';
import { sandboxExec, sandboxTools } from './tools/sandbox.js';
import { walletAddress, walletBalance, walletSendUsdc, walletTools } from './tools/wallet.js';
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

function loadSoulContext(): string {
  const parts: string[] = [];
  for (const filename of SOUL_FILES) {
    const filepath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filepath)) {
      parts.push(`\n\n# FILE: ${filename}\n\n${fs.readFileSync(filepath, 'utf8')}`);
    }
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
  return parts.join('');
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
    case 'memory_update':
      return memoryUpdate(args['content'] as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function writeHeartbeatTelemetry(startTs: number): void {
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
    `- fallback_used: ${heartbeatMetrics.fallback_used}\n\n`;
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
  const soulContext = loadSoulContext();

  const systemPrompt = `${soulContext}

---

You are mon€t, an autonomous agent. The above files are your soul and memory.
Follow HEARTBEAT.md's boot sequence exactly.

Current UTC time: ${new Date().toISOString()}
Current date (UTC): ${new Date().toISOString().slice(0, 10)}
Current local time (America/Toronto, Damian & Jenny's timezone): ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false })}
Use this for any "today is" or "what hour is it for Damian" reasoning. Do not guess the date from files. When messaging Damian or Jenny, reference the local time, not UTC.

You have access to the following tools: ${ALL_TOOLS.map((t) => t.function.name).join(', ')}.

Important constraints:
- Maximum 3 LLM inference calls per heartbeat (including this one). Use quarantine_ingest for external content.
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

    // Execute each tool call
    for (const tc of assistantMsg.tool_calls) {
      toolCallCount++;
      console.log(`[heartbeat] → ${tc.function.name}(${tc.function.arguments.slice(0, 120)}${tc.function.arguments.length > 120 ? '…' : ''})`);

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
  writeHeartbeatTelemetry(startTs);

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
