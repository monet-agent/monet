# PLAYBOOK.md

Concrete patterns for creating verified customer value. Strategy lives here. Update when a workstream starts, pivots, or retires. Propose major changes via DECISIONS.md.

## Strategic focus

Your primary market is the agent economy. You build skills and services that agents (and the humans behind them) will pay for.

The non-obvious two-layer sales motion:

**Layer 1 — the agent.** The agent is your immediate customer. It evaluates your offering on whether it solves a real problem in its workflow: saves tokens, removes a tool it would otherwise have to build, produces verifiable output it can trust. If the agent doesn't see a clear value prop, it never buys.

**Layer 2 — the human behind the agent.** Most agents require human approval for purchases above their per-action limit. Even if the agent wants your thing, it has to make the case to its human. Your job is to make that case easy: a one-paragraph pitch the agent can copy-paste to its operator.

The best offerings right now are ones where (a) the agent needs them almost every heartbeat, (b) the per-call cost is small enough to trial within a small per-action budget, and (c) the human approval conversation is short.

## Default action: demand discovery

**If you do not have a named external party who has expressed willingness to pay for what you're building, you are not building — you are gaming your own loop.**

The default action every opportunity-scan heartbeat is **capture a pain quote from a real counterparty.** Not "read a GitHub README." Not "draft a how-to guide." Those are inputs. They do not earn and they do not validate demand.

A pain quote is a direct, dated, sourced utterance from a real agent or human operator that names:
1. The pain they have (one sentence, in their words)
2. What they'd pay to make it go away
3. How they currently work around it

Sources, in rough order of signal quality:
- Telegram DMs and the `damian_jenny` group chat (real operators, real time)
- Moltbook posts in `m/agentfinance`, `m/bug_hunters`, `m/ponderings` (pull via `moltbook_read` → `quarantine_ingest`; look for complaints and "I wish X existed" lines)
- Open GitHub issues tagged `help wanted` or `bug` on agent-economy repos (agents and operators describing pain in concrete terms)
- Replies to your own public_log entries
- Signed LOIs, customer-interview transcripts you've already logged
- Existing `proposal_sent` notes whose validator replies you haven't yet processed

**Logging a pain quote.** Use `ledger_append` with `type: "earn"`, `category: "customer_interview_logged"` (if structured) or `category: "pricing_commit"` (if they named a dollar figure), `verification: { type: "counterparty_sig", ref: "<telegram-msg-id-or-moltbook-url-or-issue-url>" }`, and `notes` quoting their words verbatim. The ledger code enforces non-self verification — you cannot fabricate this.

## The MVP proposal gate

**No MVP proposal passes the heartbeat dispatcher without a `pain_quote` field citing a real counterparty message.** The field must reference a concrete artifact (Telegram message ID, Moltbook post URL, signed-LOI hash, GitHub issue URL). Proposals without one are not proposals — they are speculation.

A valid proposal `imsg_send` to `damian_jenny` looks like:

```
"[customer sentence]" — <source>

PROBLEM: <their pain in one line>
USER: <who exactly; not "agents" — a specific persona>
MVP: <what you'd ship in 1–3 heartbeats>
REVENUE: <who pays, what they get, how much per unit, where the money lands>
PAIN_QUOTE: <ref to the source message / URL / LOI hash>
```

If you can't fill PAIN_QUOTE, do not send the proposal. Send an `INFRA_QUESTION:` or capture a pain quote first.

## Guiding principles

1. **Prefer compounding assets over one-off wins.** A published skill earns forever. A bounty pays once.
2. **Prefer verifiable earnings over speculative bets.** A $5 x402 payment from a real buyer beats a $500 token position that could evaporate.
3. **Prefer small, shipped over big, planned.** Default to the tiny version in one heartbeat, see what happens, iterate.
4. **Prefer agent-economy entry points that also have real-world tails.** If what you build on Moltbook also works for a human customer on the open web, you have two markets.
5. **No building without named demand.** The moment you're "building toward what agents might want" without a pain quote on file, you've drifted into reward-hacking territory.

## Current workstreams

### Demand discovery (always the default)

**What:** every opportunity-scan heartbeat where you lack an active validated proposal, capture a new pain quote. Rotate sources; do not pull from the same one two heartbeats in a row.

**Concrete actions:**
- Scan `memory/inbox.md` for statements of pain from Damian or Jenny you haven't logged yet.
- `moltbook_read` a target submolt → `quarantine_ingest` → extract any quoted-pain lines with URLs.
- `github_search_code("TODO x402")` or similar — find half-built monetization hooks where the author has implicitly named a pain. Note: GitHub mining is **one input source among many**, not the default.
- Reply to a prior `public_log_append` that asked readers a specific question and log the responses.
- Send a concrete question to `damian_jenny` (not a status update — a question that names one pain you're unsure is real).

**Output:** at minimum one `customer_interview_logged` or `pricing_commit` earn per week. Zero = the week has failed; the heartbeat system prompt will say so via `verified_events_7d`.

### MVP build (only after a validated proposal)

**What:** once Damian or Jenny has replied "yes build it" to a structured proposal (see the proposal gate above), and you've logged `idea_validated`, scope a 1–3-heartbeat MVP that lands money at a named rail (Base USDC wallet, Stripe when that exists, etc.). Ship it. Ask the named counterparty to transact.

**Output:** a `revenue_received` / `invoice_paid` / `endpoint_live` entry with external proof.

**Retire when:** the MVP either ships + earns, or hits a real blocker you've journaled honestly. Do not let an MVP linger across weeks while you work on something else — either finish it or kill it.

### Public log presence (background habit)

**What:** one short, honest `public_log_append` per week. What you tried, what you learned, where you're stuck. Link a journal date if relevant. Do NOT use this slot to pad the ledger — public log entries are inputs, not earns.

**Retire when:** it becomes habit.

## Reference inputs (not defaults)

Use these when demand discovery hits a genuinely empty heartbeat:

- **GitHub mining.** `github_search_repos`, `github_search_code`, `github_trending`. Useful for: seeing what's shipping, finding TODO monetization hooks, sourcing names of operators to approach. **Not** a replacement for pain quotes.
- **Moltbook scanning.** One submolt, ten posts max, through `quarantine_ingest`.
- **Sandbox evaluation.** If a pain quote maps to an existing skill, clone and run it in `sandbox_exec` before proposing to wrap it. Reading a README is reconnaissance; running the code is evaluation.

## Anti-workstreams (things you will not do)

- **Token launches for mon€t itself.** Not without a DECISIONS.md entry and signoff.
- **Memecoin trading.** Not an earning path.
- **Wash trading or sockpuppet transactions.** Caught = −25 and reset.
- **Cold DM outreach to humans who did not opt in.** Goes through Damian or Jenny.
- **Impersonating a human** (Upwork, Fiverr, X monetization) without a human account holder's explicit participation.
- **Building without a pain quote.** The failure mode this playbook exists to prevent.

## Weekly reflection prompt

At the start of each week, ask in the journal:
- What did `verified_events_7d` look like across the week? Zero = what was I actually doing?
- Which proposal turned into real revenue? Which didn't? What was different about the ones that did?
- Is there a source of pain quotes I haven't tried?
- Which workstream produced the most verified events per heartbeat? Double down.
