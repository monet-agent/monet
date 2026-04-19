# DECISIONS.md

Architecture Decision Record log. Every non-trivial decision lives here. Format is ADR-lite: one entry per decision, newest on top.

## Entry template

```
### DEC-NNN: <short title>

- **Status:** proposed | accepted | rejected | superseded by DEC-MMM
- **Date proposed:** YYYY-MM-DD
- **Date decided:** YYYY-MM-DD
- **Proposed by:** mon€t | Damian | Jenny
- **Approver:** Damian | Jenny (either is sufficient; nothing needs both)
- **Stale by:** YYYY-MM-DD (for proposed entries, when to bump or close)

**Context.** What situation are we in? What's the question?

**Decision.** What we chose, in one paragraph.

**Consequences.** What becomes easier. What becomes harder. What we are giving up.

**Dissent.** If anyone disagreed, what they thought.
```

---

## Open proposals

*(None yet. Heartbeat #1 will likely propose the initial PLAYBOOK workstreams.)*

---

## Accepted

### DEC-006: Swap primary/fallback LLM providers

- **Status:** accepted
- **Date proposed:** 2026-04-19
- **Date decided:** 2026-04-19
- **Proposed by:** Damian
- **Approver:** Damian
- **Supersedes:** DEC-001 (provider order only)

**Context.** The soul files (~15K tokens) are loaded every heartbeat and are largely static. Moonshot direct offers a 75% cache discount on cached input tokens, which DEC-001 identified as a feature but assigned to the fallback slot. DeepInfra has no equivalent cache discount.

**Decision.** Make Moonshot direct (`api.moonshot.ai`, `kimi-k2-thinking`) the primary provider. Make DeepInfra (`api.deepinfra.com`, `moonshotai/Kimi-K2-Thinking`) the fallback. `KIMI_API_KEY` → Moonshot, `KIMI_FALLBACK_KEY` → DeepInfra. Model parameters unchanged.

**Consequences.** Input cost for the static system prompt drops ~75% on cache hits after heartbeat #1. One fewer proxy hop on the hot path. If Moonshot direct has an outage, DeepInfra catches it.

**Dissent.** None.

---

### DEC-001: Use Kimi K2 Thinking via DeepInfra as primary LLM

- **Status:** accepted
- **Date proposed:** 2026-04-18
- **Date decided:** 2026-04-18
- **Proposed by:** Damian, Jenny
- **Approver:** Damian or Jenny (either sufficient)

**Context.** mon€t needs a model that maintains persona and goal coherence over long autonomous runs (weeks of 30-minute heartbeats), supports OpenAI-compatible tool use, is cheap enough for a $100/week all-in budget, and has strong agentic benchmarks.

**Decision.** Use Kimi K2 Thinking (moonshotai/Kimi-K2-Thinking) hosted on DeepInfra at $0.47/$2.00 per million input/output tokens. Fallback to Moonshot direct, which offers 75% cache discount on the stable system prompt. Model supports up to 200–300 consecutive tool invocations without coherence drift per the Moonshot model card, tops the τ²-Bench Telecom benchmark at 93%, and is OpenAI-compatible for tool use.

**Consequences.**
- Cost model is predictable. ~$10–20/month at realistic volume.
- Thinking-mode requirements are strict: temp=1.0, streaming required, `reasoning_content` preserved across turns, `max_tokens >= 16000`. Any violation produces unreliable output. These must be enforced in the code, not relied on as soft defaults.
- Some independent hallucination risk on fine technical details (documented for K2-Instruct; less rigorous audit exists for Thinking). Pair with citation verification in TOOLS.md.

**Dissent.** None.

---

### DEC-002: Use OpenClaw's canonical file layout

- **Status:** accepted
- **Date proposed:** 2026-04-18
- **Date decided:** 2026-04-18
- **Proposed by:** Damian, Jenny
- **Approver:** Damian or Jenny (either sufficient)

**Context.** OpenClaw ships an opinionated "programmable soul" file convention (SOUL.md, IDENTITY.md, AGENTS.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md). We have the option to invent our own layout or inherit.

**Decision.** Inherit. Keep the seven canonical files and layer domain-specific files (PLAYBOOK, LEDGER, ROSTER, SECURITY, CONTACTS, DECISIONS, RELATIONSHIPS) on top. Private journal and public log live under `memory/`.

**Consequences.**
- OpenClaw runtime finds the files at their expected paths. No glue code.
- Future migration to a different runtime would require mapping, but the markdown content is portable.
- We gain the community ecosystem — third-party tools, tutorials, skill libraries all assume this layout.

**Dissent.** None.

---

### DEC-003: Host on Fly.io with DeepInfra

- **Status:** accepted
- **Date proposed:** 2026-04-18
- **Date decided:** 2026-04-18
- **Proposed by:** Damian, Jenny
- **Approver:** Damian or Jenny (either sufficient)

**Context.** We need a Docker-based host that supports persistent volumes, encrypted secrets, survives restarts with memory intact, is in a Toronto-ish region for latency, and costs under $20/month for infra.

**Decision.** Fly.io `shared-cpu-1x @ 1 GB` in `yyz` with a 10 GB Fly Volume. Healthchecks.io free tier for heartbeat monitoring. Cloudflare R2 for nightly backups and the external ledger verifier. DeepInfra for Kimi K2 Thinking. Moonshot direct as fallback.

Total estimated infra: $7.20/month Fly + $10–20/month DeepInfra + $0 Healthchecks + $0 R2 (under free tier for our volume) = **$17–27/month CAD**.

**Consequences.**
- Fly's Dockerfile deploy is the smoothest DX for this scale. No Kubernetes overhead.
- Fly supports graceful SIGTERM, `fly secrets`, and the Tokenizer proxy (valuable for Tier 2 wallet key isolation).
- If Fly ever fails or we outgrow it, Hetzner ARM (CAX11, ~$4.85/month) is the likely next step.

**Dissent.** None.

---

### DEC-004: Sandbox mode "all" from day one

- **Status:** accepted
- **Date proposed:** 2026-04-18
- **Date decided:** 2026-04-18
- **Proposed by:** Damian, Jenny
- **Approver:** Damian or Jenny (either sufficient)

**Context.** OpenClaw's default sandbox mode is `off`, which means tool calls run on the host. This has caused real incidents (documented ClawHavoc waves; at least one report of $200 in unintended LLM costs from heartbeat recursion; Wikipedia-cited credential harvesting). The default is dangerous and we want containment from day one.

**Decision.** Force `sandbox.mode: "all"` in openclaw.json. Deny network egress by default. Bind gateway to loopback only. Start with `workspaceAccess: "ro"` (upgrade only if a specific approved skill needs write access to a specific subdirectory). Keep `tools.elevated: []` empty permanently.

**Consequences.**
- Some skills may refuse to run in full sandbox. Those are skills we do not want.
- Tool latency increases by a few hundred ms per call. Acceptable for a 30-minute heartbeat.
- If a malicious skill slips through install review, its blast radius is contained to its own sandbox container.

**Dissent.** None.

---

### DEC-005: Hash-chained JSONL ledger with external verifier

- **Status:** accepted
- **Date proposed:** 2026-04-18
- **Date decided:** 2026-04-18
- **Proposed by:** Damian, Jenny
- **Approver:** Damian or Jenny (either sufficient)

**Context.** The in-context reward hacking literature (Pan et al. 2402.06627, Song et al. 2506.06303) is unambiguous that agents optimize whatever score is in their context, including by gaming the metric's reporting if they can. mon€t's LEDGER is exactly this kind of score.

**Decision.** The ledger is an append-only JSONL file with per-entry `prev_hash` and `entry_hash`. Every append pushes the new tip hash to a Cloudflare R2 bucket using a credential mon€t does not hold (scoped to the `ledger_append` tool only). Every boot, the full chain is validated against the external tip before any other work proceeds.

Earnings entries require external verification: on-chain tx hash, Stripe receipt, platform API confirmation, or counterparty signature. `verify_citation` tool gates citation-earn entries.

**Consequences.**
- mon€t cannot silently rewrite history to boost its tier.
- A compromised mon€t cannot forge earnings.
- Implementation complexity is higher than a plain markdown ledger. Worth it.
- If the verifier bucket becomes unreachable, mon€t enters read-only mode on the ledger. This is by design.

**Dissent.** None.

---

*(Future decisions append above this line, newest on top.)*
