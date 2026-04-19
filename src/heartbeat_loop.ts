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
import { imsgSend, telegramTools } from './tools/telegram_bridge.js';
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
Use this for any "today is" reasoning. Do not guess the date from files.

You have access to the following tools: ${ALL_TOOLS.map((t) => t.function.name).join(', ')}.

Important constraints:
- Maximum 3 LLM inference calls per heartbeat (including this one). Use quarantine_ingest for external content.
- Wall-clock limit: ${MAX_HEARTBEAT_MINUTES} minutes. Stop before that and journal where you got to.
- Never output image markdown or <img> tags.
- journal_append is required before public_log_append.
- At minimum, call journal_append and healthcheck_ping("ok") before ending.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Heartbeat starting. Time: ${new Date().toISOString()}. Run the boot sequence from HEARTBEAT.md now.`,
    },
  ];

  // ── 3. Tool-use loop ──────────────────────────────────────────────────────
  let toolCallCount = 0;

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

  // ── 4. End-of-heartbeat seal ──────────────────────────────────────────────
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
