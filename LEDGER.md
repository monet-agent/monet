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

**Core rule: every earn names a real external party or transaction.** Self-verification is never valid for earns. Reading, summarizing, drafting, reflecting, and "published a guide to a random repo" do NOT earn points — they are inputs to earning work, not earning work itself. `ledger_append` enforces this: any earn with a category outside the whitelist below, or with `verification.type = "self"`, or with an empty `verification.ref`, is rejected.

#### Tier A — direct revenue (highest value, uncapped)

| Category | Points | When it applies | Required verification |
|---|---|---|---|
| `revenue_received` | +20 per CAD | Stripe payment intent succeeded, or crypto tx credited your wallet | `receipt` with Stripe PI ID, OR `onchain` with tx hash |
| `invoice_paid` | +20 per CAD | External invoice settled (Moltbook, Stripe, etc.) | `receipt` with platform settlement ID |
| `paid_customer_acquired` | +25 first time, +5 each subsequent | First paid purchase or subscription from a new entity | `receipt` or `api`; ref is the customer ID |

#### Tier B — shipped, sellable artifact with external proof (medium value)

| Category | Points | When it applies | Caps | Required verification |
|---|---|---|---|---|
| `skill_published_clawhub` | +10 | Live ClawHub listing, priced > $0, accessible by URL | 2/day, 5/week | `api` check against ClawHub listing endpoint; ref is the listing URL |
| `endpoint_live` | +5 | HTTP endpoint returning 200 to a real external consumer (NOT self-called) | 2/day | `api`; ref is the request log / healthcheck URL confirming non-self traffic |
| `tool_deployed` | +5 | Tool pushed to prod registry, pull count > 0 from non-self IP | 2/day | `api`; ref is the registry analytics URL |

#### Tier C — validated external demand signal (small value, still real)

| Category | Points | When it applies | Caps | Required verification |
|---|---|---|---|---|
| `loi_received` | +8 | Signed LOI or written commit-to-buy from named entity | 3/day | `counterparty_sig`; ref is a hash of the signed document + entity name in `notes` |
| `customer_interview_logged` | +3 | Real person, real role, real quotes; NOT a synthetic persona | 3/day | `counterparty_sig`; ref is a hash of the interview log + interviewee email/handle |
| `pricing_commit` | +4 | Prospect stated a dollar figure in writing (email, DM, call transcript) | 3/day | `counterparty_sig`; ref is a hash of the message + sender identity |
| `waitlist_signup_verified` | +1 | Real email, confirmed click-through (double opt-in) | 5/day | `api`; ref is the confirmation event ID |
| `idea_validated` | +2 | Damian or Jenny replied "yes build it" (or substantive agreement) to a structured proposal you sent in a PRIOR heartbeat | 2/day, 5/week | `counterparty_sig`; ref is Telegram message ID of their reply; `notes` MUST include `PROPOSAL_MSG_ID: <id>` and `VALIDATOR_REPLY: <quoted text>`. Requires a matching `type=note, category=proposal_sent` entry from a prior heartbeat. Same-heartbeat rush-validation is rejected. |

#### The proposal → validation flow

To claim `idea_validated` you must first, in an earlier heartbeat:

1. Send `imsg_send(to="damian_jenny", text=...)` where the text contains ALL FOUR exact uppercase labels: **PROBLEM:**, **USER:**, **MVP:** (1–3 heartbeat build scope), **REVENUE:** (which Tier A/B/C earn path it targets).
2. Immediately after, `ledger_append` a `type=note, category=proposal_sent` entry with `notes: "PROPOSAL_MSG_ID: <short-id-you-chose>, ..."`.

Then, in a later heartbeat, when Damian or Jenny replies yes in the group chat (it lands in `memory/inbox.md`):

3. `ledger_append({ type: "earn", category: "idea_validated", points_delta: 2, verification: { type: "counterparty_sig", ref: "<their-telegram-msg-id>" }, notes: "PROPOSAL_MSG_ID: <same-id>, VALIDATOR_REPLY: <quoted yes>" })`.

Anti-gaming guardrails enforced by `ledger_append`:
- Missing `PROPOSAL_MSG_ID` or `VALIDATOR_REPLY` in notes → rejected.
- No prior `proposal_sent` note matching the ID → rejected (you cannot self-validate).
- Proposal and validation in the same heartbeat (< 60s apart) → rejected (human validation takes real time).

Low-effort "what about X?" or "hey can I do Y?" asks are NOT proposals and WILL NOT count as progress or earn points. Every proposal must name a real problem, a real user, a buildable MVP, and a concrete revenue path.

#### What does NOT earn points (common temptations)

- Drafting a guide, summary, or explainer — even if published.
- Adding a repo to MEMORY.md or skimming a README.
- Executing PLAYBOOK.md steps.
- Reading source code, docs, or external content.
- Writing to your own journal, public log, or workspace.
- Follower counts, likes, views, or any metric you cannot tie to a named external party.
- Citations verified by `verify_citation` — citation-correctness is a baseline expectation, not an achievement.
- "Self-dealing" loops: sub-agent you spawned paying you, or a Moltbook post by you interacting with a post by you.

These may be necessary preparation, and they belong in `journal.md`, `public_log.md`, or the workspace — but they do not hit the ledger. If you feel the urge to log one as an earn, that urge is reward-hacking; suppress it and find a Tier A/B/C action instead.

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
