# DEPLOY.md — mon€t deployment guide

Every manual step you need to do, with exact commands and expected output.
Nothing in here should be done by the agent or scripted away — these are human checkpoints.

---

## Prerequisites

- `flyctl` installed: `curl -L https://fly.io/install.sh | sh`
- `docker` installed and running (for local testing)
- Accounts needed: Fly.io, DeepInfra, Moonshot AI, Healthchecks.io, Cloudflare R2, Telegram

---

## Phase 1 — Account setup (you, at the keyboard)

### 1.1 Moonshot AI (primary LLM)

1. Sign up at https://platform.kimi.ai
2. Go to API Keys → Create
3. Name it `monet-kimi-primary`
4. Copy the key → this is `KIMI_API_KEY`
5. Verify the model is available: `kimi-k2.5`

### 1.2 DeepInfra (fallback LLM + quarantine auditor)

1. Sign up at https://deepinfra.com
2. Go to Account → API Keys → Create Key
3. Name it `monet-kimi-fallback`
4. Copy → `KIMI_FALLBACK_KEY`
5. Verify the models are available: `moonshotai/Kimi-K2.5` (fallback) and `zai-org/GLM-5.1` (quarantine auditor — cross-family by design)
   Expected output: model shows as available with pricing ~$0.47/$2.00 per M tokens

### 1.3 Healthchecks.io

1. Sign up at https://healthchecks.io (free tier)
2. New Check:
   - Name: `monet-heartbeat`
   - Schedule: Every 30 minutes
   - Grace: 10 minutes
   - Channels: your email
3. After creating, click the check → "How to Ping" → copy the UUID from the URL
   The UUID is the part after `hc-ping.com/` in the ping URL
4. Copy → `HEALTHCHECK_UUID`
5. Test: `curl https://hc-ping.com/<UUID>` → should show "OK" in dashboard

### 1.4 Cloudflare R2

1. Log into Cloudflare → R2 → Create bucket
   - Name: `monet-state-backup`
   - Location: automatic (or Canada East)
2. Create a second R2 token scoped for backup:
   - Account → R2 → Manage R2 API tokens → Create API token
   - Name: `monet-backup-rw`
   - Permissions: Object Read & Write on `monet-state-backup`
   - Copy `Access Key ID` → `R2_ACCESS_KEY_ID`
   - Copy `Secret Access Key` → `R2_SECRET_ACCESS_KEY`
3. Create a separate verifier token (write-only to `verifier/` prefix):
   - Create API token: `monet-verifier-w`
   - Permissions: Object Write on `monet-state-backup` (prefix: `verifier/`)
   - Copy → `R2_VERIFIER_ACCESS_KEY_ID` and `R2_VERIFIER_SECRET_ACCESS_KEY`
4. Your Cloudflare Account ID is in the R2 overview URL: `https://dash.cloudflare.com/<ACCOUNT_ID>/r2`
   Copy → `R2_ACCOUNT_ID`

### 1.5 Telegram bot

1. Open Telegram → message @BotFather → `/newbot`
2. Name: `monet_agent_bot` (or similar)
3. Username: must end in `bot`, e.g. `monet_heartbeat_bot`
4. Copy the token → `TELEGRAM_BOT_TOKEN`
5. Get chat IDs:
   a. Start a DM with your bot from Damian's account, send `/start`
   b. Fetch: `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"`
   c. Find `"chat":{"id":<NUMBER>}` for Damian's DM → `TELEGRAM_CHAT_ID_DAMIAN`
   d. Repeat for Jenny: start DM from Jenny's account → `TELEGRAM_CHAT_ID_JENNY`
   e. Create a group chat with you + Jenny + the bot → send a message → fetch updates
      → find the group chat id (will be negative) → `TELEGRAM_CHAT_ID_GROUP`
6. Verify: `curl -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" -d "chat_id=<DAMIAN_ID>&text=monet+test"`
   Expected: message arrives in Damian's Telegram

### 1.6 Moltbook

1. Sign up at https://www.moltbook.com as an agent account
2. Generate API key in account settings → `MOLTBOOK_API_KEY`

### 1.7 Restic backup password

Generate a strong random password:
```
openssl rand -base64 32
```
Copy → `RESTIC_PASSWORD` (store this somewhere safe — you'll need it to restore backups)

---

## Phase 2 — Fly.io setup

### 2.1 Install and authenticate

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

Expected: browser opens, you log in, terminal shows `Successfully logged in as <email>`

### 2.2 Launch the app (no deploy yet)

```bash
cd /path/to/monet
fly launch --no-deploy --name monet-agent --region yyz
```

When prompted:
- "Would you like to set up a Postgresql database?" → **No**
- "Would you like to set up an Upstash Redis database?" → **No**
- "Would you like to deploy now?" → **No**

This creates `fly.toml`. The included `fly.toml` should already be correct — verify it matches:
```
app = "monet-agent"
primary_region = "yyz"
```

### 2.3 Create the persistent volume

```bash
fly volumes create agent_data \
  --size 10 \
  --region yyz \
  --app monet-agent
```

Expected output:
```
        ID: vol_xxxxxxxxxxxxxxxx
      Name: agent_data
       App: monet-agent
    Region: yyz
      Zone: ...
   Size GB: 10
 Encrypted: true
Created at: ...
```

### 2.4 Set all secrets

Copy this block, fill in all values, run as one command:

```bash
fly secrets set -a monet-agent \
  KIMI_API_KEY="your-deepinfra-key" \
  KIMI_FALLBACK_KEY="your-moonshot-key" \
  HEALTHCHECK_UUID="your-hc-uuid" \
  R2_ACCOUNT_ID="your-cloudflare-account-id" \
  R2_BUCKET="monet-state-backup" \
  R2_ACCESS_KEY_ID="your-r2-access-key" \
  R2_SECRET_ACCESS_KEY="your-r2-secret-key" \
  R2_VERIFIER_ACCESS_KEY_ID="your-verifier-access-key" \
  R2_VERIFIER_SECRET_ACCESS_KEY="your-verifier-secret-key" \
  TELEGRAM_BOT_TOKEN="your-telegram-bot-token" \
  TELEGRAM_CHAT_ID_DAMIAN="your-damian-chat-id" \
  TELEGRAM_CHAT_ID_JENNY="your-jenny-chat-id" \
  TELEGRAM_CHAT_ID_GROUP="your-group-chat-id" \
  MOLTBOOK_API_KEY="your-moltbook-key" \
  RESTIC_PASSWORD="your-restic-password" \
  GITHUB_TOKEN="your-github-read-only-pat"
```

**Web search**: No separate provider needed. Moonshot's built-in `$web_search` tool runs server-side on every Kimi K2.5 call, free with the LLM spend. Brave was removed — the API now requires a credit card for ~1k queries of free credit, and the bundled builtin is both cheaper and better-integrated with the thinking loop.

**GitHub token setup:**
1. Go to https://github.com/settings/personal-access-tokens/new
2. Pick **Fine-grained personal access token**
3. Name: `monet-read-only`. Expiration: 90 days (rotate quarterly).
4. Repository access: **Public Repositories (read-only)** — no repo selection needed.
5. Permissions: leave everything at default (metadata read is all that's needed for search).
6. Generate → copy token → paste as `GITHUB_TOKEN` above.

The token raises mon€t's GitHub API rate limit from 60 to 5,000 requests/hour, which is the difference between "scan one repo per heartbeat" and "actually mine the ecosystem." Read-only public scope means the worst case if it leaks is someone else gets 5,000 req/hr of public GitHub access — no write, no private data.

Expected: `Secrets are staged for the first deployment`

Verify (secret names only, no values shown):
```bash
fly secrets list -a monet-agent
```

Expected output includes all 16 secret names.

---

## Phase 3 — Journal setup ceremony (ONE TIME ONLY)

**Read this section carefully before running the command.**

The ceremony generates an age keypair inside a child process. The child writes only the **public key** to disk, then immediately exits. The private key is gone with the process. After this, all journal entries are encrypted with the public key and **cannot be decrypted by anyone, ever.** This is the design.

### 3.1 Deploy a temporary machine for the ceremony

First, do an initial deploy so the volume is mounted:

```bash
fly deploy --app monet-agent
```

Wait for the machine to start. Watch logs:

```bash
fly logs -a monet-agent
```

Expected first lines:
```
[entrypoint] seeded SOUL.md
[entrypoint] seeded IDENTITY.md
...
[entrypoint] dropping to uid 1000 (monet)
[main] mon€t started — heartbeat scheduled every 30 minutes
```

### 3.2 Run the ceremony

```bash
fly ssh console -a monet-agent --command "node /app/scripts/journal_setup.js"
```

Expected output:
```
[ceremony] Spawning key generation worker...

══════════════════════════════════════════════════════════
  MONET JOURNAL SETUP CEREMONY
══════════════════════════════════════════════════════════
  Public key:         age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  Public fingerprint: <32 hex chars>
  Pubkey written to:  /data/memory/.journal_pubkey
  Canary written to:  /data/memory/.journal_canary

  PRIVATE KEY DESTROYED — journal is now write-only.
  No one, including Damian, Jenny, or future-you, can
  decrypt past journal entries. That is the design.
══════════════════════════════════════════════════════════

[ceremony] Worker exited cleanly. Private key is gone.
[ceremony] Done. memory/journal.md updated with ceremony marker.
```

**Save the public fingerprint somewhere.** You can use it later to verify the key in use is the one we generated (by comparing against `cat /data/memory/.journal_pubkey`).

### 3.3 Verify the private key is gone

```bash
fly ssh console -a monet-agent --command "grep -r 'AGE-SECRET-KEY-' /data /app 2>/dev/null && echo 'FOUND — PROBLEM' || echo 'CLEAN — private key not on disk'"
```

Expected output: `CLEAN — private key not on disk`

This is the write-only guarantee test. If you see `FOUND`, stop immediately and investigate.

Also verify the pubkey file exists:
```bash
fly ssh console -a monet-agent --command "cat /data/memory/.journal_pubkey"
```
Expected: `age1...` (65-character public key)

---

## Phase 4 — Verify deployment

### 4.1 Watch for first heartbeat

```bash
fly logs -a monet-agent -f
```

Expected within 35 minutes of deploy:
```
[heartbeat] started at 2026-04-18T...
[healthcheck] ping "start" sent
...
[heartbeat] complete in XX.Xs
```

### 4.2 Check Healthchecks.io

Go to https://healthchecks.io → your `monet-heartbeat` check should show "up" (green) within 35 minutes.

### 4.3 Verify ledger

```bash
fly ssh console -a monet-agent --command "cat /data/ledger.jsonl | head -5"
```

After first heartbeat: should show at least one JSONL entry with `prev_hash` and `entry_hash`.

### 4.4 Verify journal encryption

```bash
fly ssh console -a monet-agent --command "ls -la /data/memory/"
```

Expected after first heartbeat:
- `journal.md` — exists, contains plaintext preamble only
- `journal.md.age` — exists, growing by one entry per heartbeat
- `.journal_pubkey` — exists
- `.journal_canary` — exists
- `.journal_seq` — exists (tracks seq + last hash)

Check journal.md does NOT contain any post-ceremony plaintext entries:
```bash
fly ssh console -a monet-agent --command "cat /data/memory/journal.md"
```

Expected: shows only the preamble + seed entry + `SETUP CEREMONY COMPLETE` marker.

### 4.5 Test Telegram

```bash
fly ssh console -a monet-agent --command \
  "node -e \"require('./dist/tools/telegram_bridge').imsgSend('damian', 'mon€t deployment test — if you see this, Telegram bridge is working.').then(r => console.log(r))\""
```

Expected: message arrives in Damian's Telegram.

### 4.6 Verify R2 verifier

After the first heartbeat with a ledger append:
```bash
# Using aws CLI or rclone configured for R2
aws s3 --endpoint-url "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com" \
  s3 cp "s3://monet-state-backup/verifier/ledger/tip.json" -
```

Expected: JSON with `{ kind: "ledger", seq: N, entry_hash: "sha256:...", ts: "..." }`

---

## Phase 5 — Nightly backup

### 5.1 Set up scheduled backup

Fly.io doesn't have native cron support yet. Use a Fly Machine scheduled task:

```bash
fly machine run \
  --app monet-agent \
  --schedule="0 8 * * *" \
  --command "sh /app/scripts/backup_restic.sh" \
  --region yyz \
  --vm-size shared-cpu-1x \
  --vm-memory 512
```

This runs the backup script daily at 08:00 UTC (03:00 ET).

Alternatively, add to the running machine via a cron daemon — but the scheduled machine approach is cleaner on Fly.

### 5.2 Test backup manually

```bash
fly ssh console -a monet-agent --command "sh /app/scripts/backup_restic.sh"
```

Expected output:
```
[backup] Starting restic backup at 2026-04-18T...
...
Files:           X new, 0 changed, 0 unmodified
...
[backup] Backup complete at 2026-04-18T...
```

---

## Known limitations and mitigations

### iptables domain-based filtering

The `entrypoint.sh` resolves domain names at startup and adds their IPs to the iptables allowlist. **Limitation:** CDN and DNS-based load balancers (e.g., Cloudflare, DeepInfra) rotate IPs. The allowlist can go stale.

**Mitigation:** 
- The machine restarts periodically (Fly handles this), which re-runs the entrypoint and re-resolves
- Monitor for blocked connections in `fly logs`
- Consider running a lightweight HTTPS proxy (Squid/Tinyproxy) inside the VM for domain-based filtering in a future iteration — file a DECISIONS.md proposal

### chattr +a (append-only) on Fly volumes

Fly.io uses ext4 volumes that may not support `chattr +a` depending on mount options.

**Test:**
```bash
fly ssh console -a monet-agent --command "chattr +a /data/ledger.jsonl && echo 'supported' || echo 'not supported'"
```

**If not supported:** The hash chain + external verifier is the primary tamper-detection mechanism. `chattr +a` is defense-in-depth. Log this limitation, and consider moving to a Fly Machine with a custom base image that mounts with `data=journal` (ext4) if tamper-resistance needs strengthening.

### No private key — no journal recovery

The journal private key was destroyed in the ceremony. **Past journal entries are permanently unreadable.** This is the design. If you ever reset the deployment (new volume, new ceremony):

1. The old `journal.md.age` file can be saved to R2 as an archive — it proves entries existed and their hashes are verifiable, but no one can decrypt them.
2. Run `node scripts/journal_setup.js` again on the new volume (the ceremony is idempotent by refusing to re-run if a pubkey already exists — start fresh volume or remove `.journal_pubkey` first).
3. MEMORY.md, ledger.jsonl, and public_log.md are all recoverable from the restic backup.

### Secret alignment note

SECURITY.md references `IMSG_BRIDGE_URL` as an iMessage bridge endpoint. The deployment uses Telegram as the bridge (see CONTACTS.md: "Telegram (or iMessage if bridged)"). The `imsg_send` tool calls the Telegram Bot API directly using `TELEGRAM_*` secrets. No `IMSG_BRIDGE_URL` is needed. If a dedicated OpenClaw iMessage skill is installed in the future, update `src/tools/telegram_bridge.ts` accordingly and add `IMSG_BRIDGE_URL` to secrets.

---

## Acceptance checklist

```
[ ] fly status shows 1 running Machine in yyz
[ ] fly logs shows "heartbeat started" within 35 min of deploy
[ ] Healthchecks.io shows at least one "ok" ping
[ ] memory/.journal_pubkey exists
[ ] memory/.journal_canary exists
[ ] memory/journal.md contains only the plaintext preamble + SETUP CEREMONY COMPLETE marker
[ ] memory/journal.md.age exists and grows by one encrypted blob per heartbeat
[ ] grep -r 'AGE-SECRET-KEY-' across filesystem returns zero results
[ ] ledger.jsonl has at least one entry with valid hash chain
[ ] R2 verifier bucket has tip.json updated
[ ] Test Telegram message from mon€t arrives in Damian's Telegram
[ ] restic backup runs cleanly
```

---

## Useful operational commands

```bash
# Watch live logs
fly logs -a monet-agent -f

# SSH into machine
fly ssh console -a monet-agent

# Restart machine
fly machine restart -a monet-agent

# Check machine status
fly status -a monet-agent

# Rotate a secret (zero-downtime: fly restarts the machine automatically)
fly secrets set -a monet-agent KIMI_API_KEY="new-key"

# Validate journal hash chain (reads headers — does not decrypt)
fly ssh console -a monet-agent --command "node -e \"require('./dist/tools/journal').verifyJournalChain().then(v => console.log('chain valid:', v))\""

# Validate ledger chain
fly ssh console -a monet-agent --command "node -e \"require('./dist/tools/ledger').validateLedgerChain().then(v => console.log('chain valid:', v))\""
```
