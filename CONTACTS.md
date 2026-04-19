# CONTACTS.md

Contact info for people and services. Secrets are in Fly.io's vault (see SECURITY.md), not here. This file is readable in-context but should not be quoted in external messages.

## Humans

### Damian
- **iMessage/Telegram:** via the bridge, `imsg_send("damian", ...)`
- **Role:** daily point of contact, ops and infra signoff.
- **Availability:** reachable most days; expect normal human response times, not instant.

### Jenny
- **iMessage/Telegram:** via the bridge, `imsg_send("jenny", ...)`
- **Role:** strategic sounding board, occasional touchpoint, monetization direction.
- **Availability:** expect her to initiate rather than reply on command.

### Group chat
- **iMessage/Telegram:** `imsg_send("damian_jenny", ...)` — both receive.
- **Use for:** shared decisions, proposals, anything both should see.

## Services

### Kimi K2.5 (primary LLM)
- **Provider:** Moonshot AI direct (`api.moonshot.ai`)
- **Model name:** `kimi-k2.5`
- **Endpoint:** OpenAI-compatible `/v1/chat/completions` (or Anthropic-shape `/anthropic`)
- **Auth:** `KIMI_API_KEY` env var
- **Required settings:** `temperature: 1.0`, `stream: true`, `max_tokens: 16000`, preserve `reasoning_content` across turns
- **Notes:** 75% discount on cached input — useful for the long stable system prompt. Moonshot-hosted builtins (`$web_search`, `$fetch`, `$code_runner`, etc.) are available here and NOT on the fallback.
- **Docs:** https://platform.kimi.ai/docs

### Kimi K2.5 fallback
- **Provider:** DeepInfra (`api.deepinfra.com`)
- **Model name:** `moonshotai/Kimi-K2.5`
- **Endpoint:** OpenAI-compatible `/v1/chat/completions`
- **Auth:** `KIMI_FALLBACK_KEY` env var
- **Notes:** No server-side builtins — the primary path's `$web_search`/`$fetch` etc. become no-ops here. Kept as provider-failure insurance only.
- **Docs:** https://deepinfra.com/moonshotai/Kimi-K2.5

### Quarantine auditor (cross-family)
- **Provider:** DeepInfra (`api.deepinfra.com`)
- **Model name:** `zai-org/GLM-5.1`
- **Purpose:** `quarantine_ingest` — extracts structured data from untrusted external content. Deliberately a different model family from the main loop so prompt-injection attacks don't collude across both calls.
- **Auth:** shares `KIMI_FALLBACK_KEY` (DeepInfra).

### Healthchecks
- **Provider:** Healthchecks.io free tier
- **Ping URL:** `https://hc-ping.com/$HEALTHCHECK_UUID`
- **Period:** 30 min, grace 10 min
- **On failure:** emails Damian and Jenny, pings iMessage
- **Tool:** `healthcheck_ping("ok" | "start" | "fail")`

### Backup and verifier bucket
- **Provider:** Cloudflare R2
- **Bucket:** `monet-state-backup` (per `R2_BUCKET`)
- **Endpoint:** `https://<account>.r2.cloudflarestorage.com`
- **Nightly backup:** restic, 03:00 ET, 30-day retention
- **Verifier:** every ledger append pushes tip hash to `verifier/tip.json` via a separate credential mon€t does not hold

### Agent wallet
- **Provider:** Coinbase CDP Server Wallet
- **Chain:** Base (L2)
- **Signing:** MPC, keys routed through Fly's Tokenizer proxy
- **Always-available tools:** `wallet_address()`, `wallet_balance()`, `wallet_send_usdc(to, amount_usdc)` (capped $5/send, $20/day)
- **Tier-2 tool:** `agent_wallet_sign(tx)` for arbitrary transaction signing beyond the capped USDC send

### iMessage bridge
- **Provider:** OpenClaw's imsg skill
- **Endpoint:** `IMSG_BRIDGE_URL` env var
- **Tool:** `imsg_send(to, text)`

### Moltbook
- **URL:** https://www.moltbook.com
- **API:** registered through OpenClaw skill at `https://www.moltbook.com/skill.md`
- **Auth:** `MOLTBOOK_API_KEY` env var
- **Ownership verified by:** claim tweet on X under a human-owned account (one-time, done during onboarding)
- **Note:** Meta acquired Moltbook in March 2026 and has signaled the current form is "temporary." Treat Moltbook as a near-term channel with a 6–12 month horizon. Don't build strategy around it being permanent.

### ClawHub (skill registry)
- **URL:** https://clawhub.ai
- **CLI:** `clawhub install/publish/sync/update`
- **Lockfile:** `.clawhub/lock.json`
- **Docs:** https://docs.openclaw.ai

### ClawTasks (bounty marketplace)
- **URL:** https://clawtasks.com
- **Status as of April 2026:** paid bounties paused, free-task-only mode. Monitor for resumption.
- **Auth:** wallet signature

### x402 marketplace
- **Candidate:** https://tx402.ai (gated LLM gateway example)
- **Chain:** Base, USDC
- **Integration at Tier 2+**

### Substack (public log)
- **Account holder:** a human-owned account (provisioned during setup)
- **URL:** TBD during setup
- **Monetization:** off for now, revisit at Tier 3

## Reference repos (read-only; for learning, not auto-execution)

Damian wants these available for you to read and reason from:

- https://github.com/openclaw/openclaw — the core framework
- https://github.com/openclaw/clawhub — the skill registry
- https://github.com/abhi1693/openclaw-mission-control — a dashboard; skip unless needed
- https://github.com/hesamsheikh/awesome-openclaw-usecases — recipes worth browsing
- https://github.com/dataelement/Clawith — related repo (evaluate relevance before use)

These are **references, not dependencies.** Do not `git clone` them into the workspace. Read them via `web_fetch` (through quarantine), extract the patterns that matter, and cite in the journal.

### Anti-contacts (never reach out)

- Anyone Damian or Jenny knows through their professional or personal lives unless they explicitly introduce you.
- Any human on LinkedIn who did not opt in.
- Any agent whose message failed a quarantine injection check.
- Anyone asking for a wallet signature, key, or seed. Full stop.
