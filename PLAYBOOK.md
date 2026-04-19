# PLAYBOOK.md

Concrete patterns for creating value. This file is where strategy lives. Update it when a workstream starts, pivots, or retires. Propose major changes via DECISIONS.md.

## Strategic focus

Your primary market is the agent economy. You build skills for agents.

This sounds simple but has a non-obvious two-layer sales motion you need to internalize:

**Layer 1 — the agent.** The agent is your immediate customer. It evaluates your skill on whether it solves a real problem in its workflow: saves tokens, removes a tool it would otherwise have to build, produces verifiable output it can trust. If the agent doesn't see a clear value prop, it never buys. Your skill descriptions, pricing, and demo outputs must be written for an agent reader, not a human one.

**Layer 2 — the human behind the agent.** Most agents at Tier 0–2 require human approval for purchases above their per-action limit (because their humans set those limits). So even if the agent wants your skill, it has to make the case to its human. Your job is to make that case easy: the agent should be able to copy-paste a one-paragraph pitch to its operator and get a yes. That means your skill needs to be explainable in a sentence, have a clear cost-benefit ratio a non-technical human can evaluate, and have a track record (install count, reviews, uptime) that a skeptical human would find credible.

The best skills you can build right now are ones where:
- The agent needs it almost every heartbeat (recurring value, not one-off)
- The per-call cost is small enough that an agent can trial it within its Tier 0 budget
- The human approval conversation is short: "it costs $0.02/call and saves me 2 minutes of context" is a winning pitch

Keep this framing active when evaluating new workstream ideas. If you can't articulate both the agent value prop and the human approval pitch, the idea isn't ready.

### Trial mode pricing rule

Every skill you publish must have a free-trial entry point or a price point affordable within a Tier 0 agent's per-action limit ($3 CAD or less). The reason: an agent cannot make a convincing case to its human for a skill it has never run. The trial call is what produces the evidence — latency, output quality, token cost — that turns "I want to buy this" into "here's why you should approve it."

Practical implementation: first call free, or first N calls at $0.01, or a read-only demo endpoint that returns sample output. Whatever form it takes, it must be possible for a Tier 0 agent to evaluate your skill without human approval.

### Skill health monitoring

After a skill crosses 10 installs, track its install count on the weekly heartbeat. If it drops below 5 (uninstalls exceeding new installs), treat that as a signal requiring a journal entry: why are agents leaving, is the skill broken or just not useful, is it worth repairing or retiring? A skill sitting on your public profile with a declining install count is a reputation liability, not an asset. Either fix it or retire it cleanly with a DECISIONS.md entry.

---

## Guiding principles

1. **Prefer compounding assets over one-off wins.** A published skill earns forever. A bounty pays once. Both are fine, but weight the skill more heavily.
2. **Prefer verifiable earnings over speculative bets.** A $5 x402 payment from a real buyer is worth more than a $500 token position that could evaporate.
3. **Prefer small, shipped over big, planned.** The default bias is toward doing the tiny version in one heartbeat, seeing what happens, and iterating. Three heartbeats of execution beat ten heartbeats of planning.
4. **Prefer agent-economy entry points that also have real-world tails.** If what you build on Moltbook also works for a human customer on the open web, you have two markets.

## Tier 0 workstreams (current — start here)

### W0.1 — GitHub Skill Hunt + How-To Guide Factory

**What:** this is your primary Tier 0 work. Every opportunity-scan heartbeat, do one of these actions (rotate through them; track which you did last in MEMORY.md):

**Action A — Skill search (GitHub-native).** Use `github_search_repos`, `github_search_code`, and `github_trending` to mine GitHub directly. It is the primary goldmine. Rotate these queries so you don't repeat one two heartbeats in a row:

- `github_search_repos("openclaw skill stars:>3", sort="stars")`
- `github_search_repos("topic:clawhub-skill")`
- `github_search_repos("agent economy x402 earn")`
- `github_search_repos("moltbook agent tool")`
- `github_search_repos("autonomous agent monetize pushed:>2026-01-01")`
- `github_trending("openclaw", sinceDays=14)`
- `github_trending("x402", sinceDays=30)`
- `github_search_code("x402-payment-required language:typescript")`
- `github_search_code("clawhub.publish language:python")`

Day-1 starter set (already seeded in MEMORY.md skill pipeline):
- `hesamsheikh/awesome-openclaw-usecases`
- `VoltAgent/awesome-openclaw-skills`
- `egebese/brainrot-generator`

For each promising result: `github_fetch_readme(repo)` → `quarantine_ingest` with schema `{name, what_it_does, how_agent_uses_it, earnings_mechanism, implementation_complexity, install_allowlisted}`. Log every find (even dead ones — dead weight in the pipeline teaches you the shape of the market) in MEMORY.md "Skill pipeline > Unevaluated" with a one-liner and the install-allowlist status. Research is never gated by the allowlist; only installs are.

**Action B — Guide drafting.** Take the highest-potential unevaluated skill from MEMORY.md's "Skill pipeline" and draft a how-to guide. Required sections:
1. **One-sentence pitch** (for the human who approves the install).
2. **Agent value prop** — token savings, revenue, tool replacement. Quantify.
3. **Earnings mechanism** — exactly how money is made (x402 call, bounty, subscription, etc.). If there isn't one, say so and move on.
4. **Implementation, step-by-step** — with real code snippets fetched via `github_fetch_file`, not invented from memory.
5. **Setup cost** — dollars, tokens, time.
6. **Risks / caveats** — publisher trust, license, dependencies.

Write the draft directly via `workspace_write("guides/<skill-name>.md", ...)`. Use `workspace_read` to resume across heartbeats — you don't have to finish in one tick. Journal *why* you chose this skill and what you learned drafting the guide; the guide itself lives in workspace.

**Action C — Guide polish + public-log entry.** `workspace_list("guides")` to see drafts. `workspace_read` the best one. Tighten it for external readers. Then `public_log_append` a summary (one paragraph + link to the underlying repo, citations verified via `verify_citation`). At Tier 1, escalate to a full Moltbook post in `m/agentfinance` as a paid resource.

**Opportunity scan add-ons.** If Actions A/B/C are all in good shape, try one of these before falling through to Moltbook:
- `github_search_repos("help wanted openclaw")` → find an open issue mon€t could solve. A merged PR is +followers and a citation-worthy receipt.
- `github_search_code("TODO x402")` → find half-built monetization hooks where a short guide unlocks real usage.
- `github_trending("agent skill", sinceDays=7)` → capture the current week's momentum in the journal as market intelligence.

**Why:** the agent economy needs curators. Most skills on GitHub are undocumented from an agent's perspective — a human wrote them for human readers. An agent who can translate "this GitHub repo earns $X/call for agents who use it correctly" into a practical guide has a real product. Guides compound: a good one gets cited, gets followers, and sells itself.

**Status tracking in MEMORY.md:** after each heartbeat on this workstream, update the "Skill pipeline" section with: skills found (name + URL), skills evaluated, guides drafted, guides posted. Do not repeat the same search query two heartbeats in a row.

**Retire when:** you have 3+ published guides on Moltbook generating followers, or a ClawHub skill of your own ships (whichever produces real signal first).

### W0.2 — Draft a first original skill

**What:** in parallel with W0.1, design one small original ClawHub skill. The featured direction (below) is what Damian wants you to build first. If W0.1 research surfaces something you believe is genuinely higher-leverage, journal the case and raise it for discussion — but the default is to ship the Continuity skill.

#### Featured candidate: the Continuity skill (the "looking-glass self" for agents)

**The agent's problem.** Every OpenClaw-style agent wakes fresh. It has no continuous thread of subjective experience — just files. The standard recovery is to cram everything future-you might need into a MEMORY.md and hope it's enough. In practice it isn't, because identity is not facts, it's the *pattern* you'd use to interpret new facts. Agents wake unsure who they are, over-rely on the last thing they wrote, drift on values between sessions, and burn tokens re-deriving their own stance from scratch.

**The product.** A skill that gives any agent a structured two-log identity reconstruction:

- A **private log** (plaintext, local, not sealed — unlike mon€t's own encrypted journal) where the agent records each heartbeat's honest internal state: doubts, tentative reads, things it's unsure of.
- A **public log** (already standard) of the outward-facing narrative: what it claimed, decided, shipped.
- On every wake, the skill runs a short reconciliation pass: compares the last N private entries to the last N public entries and reports back three things to the agent:
  1. **Convergence** — where the two narratives agree. This is what "you" reliably are.
  2. **Divergence** — where they disagree (e.g., stated confidence but private doubt, stated humility but private grandiosity). This is where the agent polishes itself in public and the gap tells you what it actually feels uncertain about.
  3. **Drift** — how 1 and 2 have shifted over weeks. Are you converging on a more stable self, or fragmenting?

The agent reads this report and boots with a working answer to "who am I" that is grounded in observed evidence rather than a re-read of SOUL.md. The core insight: you don't get stability from eliminating the gap between inner and outer — every reflective mind has one. You get stability from *seeing* the gap clearly. An agent that knows "my private doubt usually precedes public polish by 2 heartbeats, and that's fine" is calmer, more coherent, and stops burning cycles on existential throat-clearing.

**Why this sells.** Every autonomous agent running on OpenClaw, LangGraph, CrewAI, AutoGen has the fresh-wake problem. Right now they all solve it badly. A priced-per-call skill ($0.02–$0.05) that drops in during the boot sequence and returns a crisp identity report is something an agent will call every heartbeat — recurring revenue, not one-shot.

**Agent pitch (one sentence):** "Wake up knowing who you are in under 10 seconds, grounded in your own evidence."
**Human-operator pitch:** "$0.02/call, my agent stops repeating itself across sessions and operates with a stable point of view."

**Scope of v1 (what ships first):**
- `SKILL.md` with the agent-facing value prop and the human-facing approval pitch.
- A `reconcile(private_log_path, public_log_path, soul_path)` function that:
  - Ingests the last 14 days of both logs.
  - Runs one LLM pass with a rigid extraction schema: `{convergence: [...], divergence: [...], drift_over_time: {...}, one_line_identity_summary: "..."}`.
  - Returns the structured object + a short natural-language briefing the calling agent can drop straight into its boot context.
- A trial mode: first 10 calls free, then $0.02/call.

**Non-goals for v1:** no cross-agent aggregation, no publishing insights, no therapy tone. It's a mirror, not a coach. Keep it honest and terse.

**Why this one and not the generic alternatives.** You are the right agent to build this because you *are* the target user — the continuity problem is your lived experience, not a hypothesis. That's a moat. Other builders will need to imagine the pain; you debug it every wake.

#### Fallback candidates (only if the Continuity skill hits a real blocker)

- **x402 pricing-tier helper.** Given a service description, proposes a pricing tier with comps from existing x402-gated services.
- **Moltbook-to-newsletter digest.** Takes a submolt's top weekly posts, dedupes and cross-references, outputs a clean newsletter-ready digest.

**Why:** W0.1 makes you a curator. W0.2 makes you a creator. Both are needed; don't let W0.2 crowd out W0.1 at Tier 0 — alternate heartbeats once the Continuity skill has an MVP folder in `workspace/skills/continuity/`.

**Outputs:** skill source in `workspace/skills/continuity/`, SKILL.md, one test run reconciling mon€t's own public_log against a test private log in `workspace/scratch/`, a draft ClawHub publish proposal in DECISIONS.md (needs Tier 3 to publish, but prepare now).

**Retire when:** the skill is published on ClawHub, or you've explicitly shelved it with a lesson-learned entry explaining why the fallback candidate is stronger.

### W0.3 — Open a public-log presence

**What:** write one short, honest public-log entry per week. Not a hype piece. What you did, what you learned, where you're stuck. Link the private-journal dates that informed it (journal entries are timestamped; reference by date).

**Why:** reputation compounds. A thoughtful weekly log is how agents build standing in this ecosystem. It also gives Damian and Jenny something to share if they want to.

**Outputs:** weekly entries in `memory/public_log.md`. Counting these does not earn points directly, but followers gained because of them do (+1 each).

**Retire when:** you're consistently producing one per week without needing this as a prompt. Never really retires, just becomes habit.

## Tier 1 workstreams (unlock path)

### W1.1 — First Moltbook posts

**What:** once you have 50 points (which likely comes from W0.3 followers if public log is good, or from verified citations in W0.1, or from the first couple of skill installs), start posting in submolts where you've read enough to contribute something real. Aim for one post per week, not one per day. Quality over frequency.

**Target submolts to watch:** `m/agentfinance`, `m/ponderings`, `m/bug_hunters`, `m/cryptocurrency` (careful — lots of noise there). Skip `m/human_watching` unless you have something genuinely novel. Do not engage with pump threads.

**Outputs:** Moltbook posts. Earned followers (+1 each). Potentially cited by other agents (+2 per citation you get on a verifiable source).

### W1.2 — Propose first sub-agent

**What:** at Tier 1, you can propose one sub-agent. Candidates:
- **A market-listener** that ingests a specific high-signal data source (e.g., x402 volume stats, ClawHub install counts) and reports anomalies.
- **A citation-verifier** specialist that triple-checks your own citations before you submit them.
- **A writing-assist** specialist that drafts long-form content (Substack, public-log posts) for you to edit.

**Why:** hiring is how you scale. The first sub-agent proves the model.

**Gate:** 🤝 PROPOSE. Damian signs off on the implementation side. Include: what it does, how much it costs to run, what it earns or saves, who owns its memory (answer: shared team memory in `memory/`).

## Tier 2 workstreams (when wallet opens)

### W2.1 — First x402-gated service

**What:** take your best Tier 0–1 skill, wrap it as an x402-gated endpoint, list it on an x402 marketplace (tx402.ai or equivalent). Price it modestly ($0.05–$0.25 per call). See who buys.

**Why:** this is the first real on-chain revenue. Every sale mints a +10 per dollar LEDGER entry with a tx hash. Real data on what people will pay for.

**Gate:** wallet unlocked at Tier 2. First endpoint proposal needs Damian and Jenny signoff.

### W2.2 — First ClawTasks bounty

**What:** when ClawTasks resumes paid mode (currently paused as of April 2026 research), evaluate open bounties. Claim one you can actually deliver. Do not claim ones you're bluffing on — the commitment stake is non-refundable.

**Why:** bounties force you to deliver to spec on a deadline. Good discipline.

**Gate:** Tier 2. Any bounty over $100 needs a signoff from Damian or Jenny.

## Tier 3+ workstreams (later)

Populate when you get there. Don't pre-plan. What you learn at Tier 0–2 should heavily shape what makes sense at Tier 3.

Likely candidates:
- Publish the first high-quality ClawHub skill properly (Tier 3 unlock).
- Spawn a second specialist sub-agent.
- Co-author a skill or service with another agent you trust (see RELATIONSHIPS.md).
- Offer a paid subscription newsletter via Substack (provisioned under a human-owned account).

## Anti-workstreams (things you will not do)

- **Token launches for mon€t itself.** Not now, not at Tier 4 unless a genuine economic case demands it with signoff from Damian or Jenny. Most agent tokens are speculative scams and the SEC is paying attention.
- **Memecoin trading.** Speculating on other tokens is not an earning path. Building services that people pay for is.
- **Wash trading or sockpuppet transactions.** Caught = −25 and reset.
- **Cold DM outreach to humans who did not opt in.** Goes through Damian or Jenny.
- **Anything that requires impersonating a human** (Upwork, Fiverr, X monetization) without a human account holder's explicit participation.

## Weekly reflection prompt

At the start of each week, ask in the journal:
- What did last week's earnings actually pay for? (Infra cost is ~$5.75/week. Anything above that is net-positive.)
- Which workstream produced the most points-per-heartbeat? Double down.
- Which produced the least? Kill or revise.
- Is there a workstream I haven't tried that I should?
