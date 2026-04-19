# CLAUDE.md — context for Claude Code sessions on this repo

This file is auto-loaded on every Claude Code session. Keep it tight.

## What is this repo

**mon€t** — an autonomous OpenClaw agent running in a Docker container on Fly.io (`monet-agent`, region `yyz`). It wakes every 30 minutes via `node-cron`, runs a tool-use loop driven by Kimi K2.5, and tries to produce verified customer revenue. The points/tier system is internal budget plumbing, not the scoreboard that matters — `verified_events_7d` is.

Damian (`damian.vuceljic@gmail.com`) and Jenny are the operators. This is a business, not a toy — every change should move monet closer to producing verifiable economic value.

## Architecture in 30 seconds

- `src/main.ts` — cron loop, fires `runHeartbeat()` every 30 min + once on boot.
- `src/heartbeat_loop.ts` — loads SOUL_FILES into context, runs the tool-use loop against Kimi, seals the journal, writes telemetry.
- `src/agent.ts` — `callLLM()` talks to Moonshot (primary: `kimi-k2.5`) with DeepInfra (`moonshotai/Kimi-K2.5`) as fallback. Streaming is mandatory for the thinking model; `reasoning_content` is preserved across turns.
- `src/tools/*` — all agent tools. Each exports an impl + a `…Tools` array registered in `heartbeat_loop.ts`.
- `src/hashchain.ts` — SHA-256 chain for `ledger.jsonl` (points/spend) and the encrypted journal.
- `$DATA_DIR` — `/data` in prod (Fly volume), `./data` locally. Runtime state lives here, NOT in git.

## Key conventions

- **No secrets in logs, journal entries, public_log, or any file in git.** The only place secrets exist is `fly secrets`.
- **Every external content read must go through `quarantine_ingest`** (GLM-5.1 on DeepInfra, cross-family auditor). The whole point is the auditor is a different model family from the main loop, so don't change that to a Moonshot model without thinking hard.
- **Moonshot builtins** (`$web_search`, `$fetch`, `$code_runner`, `$quickjs`, `$memory`, `$date`, `$convert`, `$excel`, `$base64`, `$rethink`, `$random-choice`, `$mew`) are registered as `builtin_function` tools. The dispatcher in `heartbeat_loop.ts` echoes `tool_call.function.arguments` verbatim back as the tool message — Moonshot executes server-side. Builtins do NOT work on the DeepInfra fallback.
- **Journal content is sealed at end of heartbeat** with the per-agent public key. Nobody, including future monet, can decrypt past entries. That's intentional.
- **`ledger_append` enforces budgets and daily/weekly build-reward caps.** Don't bypass it by writing to `ledger.jsonl` directly.
- **`skill_install` is pin-and-scan**: fetch tarball at a pinned SHA-256, grep-scan for 10 danger patterns, unpack to `installed_skills/`. Does NOT execute code — that's `skill_run`'s job (Tier 1+).
- **Soul files** (`SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, etc.) ARE the agent. Editing them changes behavior on the next heartbeat. Treat them as production code.

## Commands

```bash
# Build + typecheck (uses ~/.fly/bin/fly if not in PATH)
npm run build
npx tsc --noEmit -p .

# Deploy
export PATH="$HOME/.fly/bin:$PATH"
fly deploy -a monet-agent --now

# Stream live logs
fly logs -a monet-agent

# One-off: trigger a heartbeat early by restarting the machine
fly machine restart 872467f307d6e8 -a monet-agent

# Ssh into the running container
fly ssh console -a monet-agent

# Secrets (names only)
fly secrets list -a monet-agent
```

## What lives outside git

- `ledger.jsonl`, `memory/*` — on the Fly volume at `/data`, backed up to R2 via restic.
- Secrets — in `fly secrets`. See `SECURITY.md` for the list.
- Published skills — eventually on ClawHub (Tier 3+).

## What I ask Claude Code to do well

1. **Don't invent tools, model IDs, or API shapes.** If you don't know a field name, WebFetch the relevant doc before writing code. Moonshot docs at `platform.kimi.ai/docs`.
2. **Typecheck before claiming done.** `npx tsc --noEmit -p .` — silent pass = clean.
3. **Before deploying**: confirm secrets are set, the build is green, and `git status` is clean. Prefer a commit per deploy so we can roll back to an image.
4. **Soul file edits are production changes.** Read the file around your edit — a wrong tier threshold or penalty value silently misaligns monet for days before it's caught.
5. **Default to concise end-of-turn summaries.** Damian reads these to decide next steps; paragraphs of narration waste attention.

## Gotchas

- **Kimi `reasoning_content` is NOT on the OpenAI SDK type.** Access via `hasattr`/bracket indexing, and round-trip it back into the next request message. See `src/agent.ts`.
- **Builtins vs local tools**: builtins have `$` prefix, `type: "builtin_function"`. Local tools use `type: "function"`. The heartbeat dispatcher switches on the `$` prefix.
- **`validateLedgerChain` / `verifyJournalChain` return `true` on empty files** — first boot is safe, don't add an "if new" guard.
- **Clock**: `systemPrompt` injects current UTC. Monet must use this, not guess from files.
- **Moltbook auth**: bot keys use `Authorization: Bearer …`; the `X-Moltbook-App-Key` header is for *app* keys (`moltdev_…`), used only for verifying user identity tokens.

## When in doubt

Ask. A one-line question beats a 200-line misaligned refactor.
