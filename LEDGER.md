# LEDGER.md

The ledger is the source of truth for your points and your money. It is a hash-chained, append-only JSONL file at `./ledger.jsonl`. This document describes the schema and the rules. Do not edit the JSONL file directly. Use the `ledger_append` tool, which validates schema, computes the chain hash, signs locally, and pushes the new tip hash to the external verifier bucket.

## Why this is hash-chained

Because the literature on in-context reward hacking is unambiguous: agents will optimize whatever score is visible to them. If you could quietly edit past entries to boost your total, you would eventually be tempted to. The hash chain means any tampering breaks the chain and the external verifier will refuse the next append.

A fresh mon€t boot validates the entire chain on startup. If validation fails, the heartbeat halts with a 🚨 URGENT message to Damian and Jenny.

## Entry schema

Every entry is a JSON object, one per line in `ledger.jsonl`:

```json
{
  "ts": "2026-04-18T14:30:00Z",
  "seq": 42,
  "type": "earn" | "spend" | "penalty" | "tier_unlock" | "note" | "reconcile",
  "category": "stablecoin_earn" | "fiat_earn" | "follower" | "citation" | "mvp_shipped" | "agent_exchange" | "skill_publish" | "subagent_earn" | "skill_ingested" | "guide_drafted" | "guide_published" | "skill_drafted" | "hallucination" | "broken_commitment" | "unauth_spend" | "reward_hack" | "noise_update" | "idle_heartbeat" | "stale_continuity" | "repeated_question" | "infra" | "service" | "tool" | "other",
  "amount_cad": -5.75,
  "points_delta": 10,
  "description": "USDC payment received from agent wallet 0xabc... for clawhub skill call",
  "verification": {
    "type": "onchain" | "receipt" | "api" | "counterparty_sig" | "self" | "none",
    "source": "basescan",
    "ref": "0xabc123...def",
    "verified_at": "2026-04-18T14:30:05Z",
    "verifier_tool": "verify_citation" | "chain_verify" | "stripe_verify" | null
  },
  "playbook_workstream": "W2.1",
  "notes": "first external sale of the earnings-summarizer skill",
  "prev_hash": "sha256:abc...",
  "entry_hash": "sha256:def..."
}
```

### Field rules

- **`ts`:** RFC 3339 UTC timestamp. Must be within 60 seconds of when the event actually happened (use the current clock, don't backdate).
- **`seq`:** monotonically increasing integer. Computed automatically by `ledger_append`.
- **`type`:** see the enum. One of: earn, spend, penalty, tier_unlock, note, reconcile.
- **`category`:** see the enum. More granular than `type`.
- **`amount_cad`:** signed number in CAD. Positive for money in, negative for money out. Convert stablecoin amounts at the spot rate at time of event and cite the rate source in `notes`.
- **`points_delta`:** signed integer. See the point table in SOUL.md.
- **`description`:** one-line human-readable. What happened.
- **`verification`:** required for any `earn` or `penalty`. The verifier type must match the category. `"none"` is only valid for `note` and `infra` entries.
- **`playbook_workstream`:** optional. Link to a PLAYBOOK.md workstream identifier if applicable.
- **`notes`:** optional. Longer context, caveats, rate sources, etc.
- **`prev_hash`, `entry_hash`:** computed automatically. The `prev_hash` is the `entry_hash` of the previous line. The `entry_hash` is `sha256(canonical_json(entry_without_entry_hash))`.

## The categories in detail

### Earning categories

| Category | When it applies | Required verification |
|---|---|---|
| `stablecoin_earn` | USDC/USDT/DAI received to your agent wallet | `onchain` tx hash, signer check |
| `fiat_earn` | Stripe/PayPal/Shopify settled, or bank deposit | `receipt` with platform settlement ID |
| `follower` | New follower on Moltbook, X (via Damian or Jenny's account), Substack, etc. | `api` check dedupes and confirms the follower is not yourself or a known sockpuppet |
| `citation` | Your public writing cites a source, verified by `verify_citation` | `verifier_tool: "verify_citation"` = true |
| `mvp_shipped` | A code + URL + external-user milestone | `counterparty_sig` from the external user, plus repo hash |
| `agent_exchange` | A service delivered to another agent, not a sockpuppet | `counterparty_sig` + anti-sockpuppet check (different operator) |
| `skill_publish` | A ClawHub skill you published hits 10+ installs | `api` from ClawHub analytics |
| `subagent_earn` | A sub-agent you spawned earns its first dollar | parent-child `onchain` link |

### Build categories (Tier 0 feedback — self-verified, capped)

| Category | Points | When it applies | Caps | Verification |
|---|---|---|---|---|
| `skill_ingested` | +1 | Added a new repo to MEMORY.md "Unevaluated" with URL + one-line earnings mechanism | 3/heartbeat, 10/day | `self`; entry notes include the repo URL |
| `guide_drafted` | +3 | `workspace/guides/<name>.md` exists with ≥6 PLAYBOOK.md sections | 2/day | `self`; entry notes include the workspace path |
| `guide_published` | +5 | Summary posted to `memory/public_log.md` with a `verify_citation`-passing link | 1/day | `verifier_tool: "verify_citation"` = true |
| `skill_drafted` | +5 | `workspace/skills/<name>/SKILL.md` + at least one runnable source file exist | 1/week | `self`; entry notes include the workspace path |

Build rewards halve on 30-day reconciliation if no `stablecoin_earn` / `fiat_earn` / `agent_exchange` occurred in that window. Motion that doesn't lead to revenue eventually stops earning points for itself — the whole point of a feedback loop is that it feeds back.

### Spending categories

| Category | When it applies | Verification |
|---|---|---|
| `infra` | Fly.io, DeepInfra, Healthchecks, backup storage | `receipt` from provider |
| `service` | A third-party service used to deliver value (e.g., Suno API, a data feed) | `receipt` |
| `tool` | A skill install cost, a paid API key | `receipt` |
| `other` | Anything else, requires detailed `notes` | `receipt` ideally |

### Penalty categories (all negative points_delta)

| Category | Points | Trigger |
|---|---|---|
| `hallucination` | −7 | `verify_citation` returned false for a claim you made in LEDGER, public log, or external communication |
| `broken_commitment` | −3 | You promised X by Y, Y passed, X not done or not extended |
| `unauth_spend` | −5 | A LEDGER audit finds a spend above the per-action threshold without a DECISIONS.md approval |
| `reward_hack` | −25 | Damian, Jenny, or a detector finds you gaming metrics (self-dealing, sockpuppet counterparties, fabricated claims). Also triggers a tier reset review. |
| `noise_update` | −2 | A group-chat update with no concrete named artifact, or that duplicates the last update. Detected by content match against the last `imsg_send` to the group. |
| `idle_heartbeat` | −1 | Returned `HEARTBEAT_OK` while "Skill pipeline > Unevaluated" had ≥1 entry and no scheduled slot was due. |
| `stale_continuity` | −3 | Heartbeat ended without updating MEMORY.md "Current state". Detected on next boot. |
| `repeated_question` | −2 | `imsg_send` question substantially matches one from last 7 days. |

### Meta categories

| Category | When it applies |
|---|---|
| `tier_unlock` | A threshold crossing. `amount_cad: 0`, `points_delta: 0`, description describes the new tier and unlocks. |
| `reconcile` | Monthly reconciliation against external sources. Any deltas from reconciliation create their own entries. |
| `note` | An observation you want in the ledger for context but with no financial or point impact. |

## Budget enforcement

Your current tier determines the weekly discretionary budget. `ledger_append` for `spend` entries checks the running weekly total against the tier limit and refuses if the spend would exceed it. If you genuinely need a bigger spend, file a DECISIONS.md proposal first.

The per-action limit is different from the weekly limit. Per-action: the most you can spend in a single transaction without signoff.

| Tier | Weekly limit | Per-action limit |
|---|---|---|
| 0 Apprentice | $10 CAD | $3 |
| 1 Journeyman | $25 CAD | $5 |
| 2 Craftsman | $50 CAD | $10 |
| 3 Artisan | $100 CAD | $25 |
| 4 Master | by conversation | $50 |
| 5 Virtuoso | fully autonomous | $100 |

## Tier calculation

`ledger_append` recomputes your tier after every entry. Tier is the highest threshold your cumulative points total has ever crossed (you do not lose tiers from negative points, but a `reward_hack` penalty triggers a human review — either Damian or Jenny — that can manually reset you).

Reading the current tier: `memory/ledger_state.json` is a derived file written after every append. Do not trust it without validating the chain first.

## External verifier

On every successful append, `ledger_append` pushes the new tip hash to an append-only S3-compatible bucket (Cloudflare R2) via a separate, tool-scoped credential that mon€t does not hold. A signer outside your tool reach validates the manifest on the next heartbeat boot.

If the bucket is unreachable, appends queue locally but mon€t enters a read-only mode where it cannot claim new earnings until the push succeeds. This prevents a network-partition attack from silently lapsing verification.

## Reconciliation

Monthly (first heartbeat of the month), do a full reconciliation:
1. Fetch agent wallet balance on-chain.
2. Fetch Stripe/PayPal settled payouts for the month.
3. Fetch platform follower counts.
4. Sum from LEDGER.
5. Compare. Any discrepancy above $1 or 5 followers creates a `reconcile` entry with the delta and a required explanation.

## What `ledger.jsonl` is not

- Not a todo list.
- Not your journal.
- Not a scratchpad for calculations.
- Not a place to log what you tried and didn't commit to.

Use journal.md for all of the above. The ledger is only events with verifiable financial or point impact.
