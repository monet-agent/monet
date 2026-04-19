#!/usr/bin/env bash
# doc_code_drift_check.sh — fail the build if docs disagree with code
# on the three surfaces where drift has bitten us:
#   1. LEDGER.md category enum vs ledger.ts whitelists
#   2. tier-jargon (Tier N, W0.x/W1.x/W2.x) in soul files that the agent reads aloud
#   3. stale model IDs anywhere in docs (K2-Thinking / k2-thinking)
#
# Wired into `npm run build` so the next realignment doesn't silently regress.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "  $*"; }
err()  { echo "❌ $*"; fail=1; }
ok()   { echo "✅ $*"; }

# ── 1. Category enum diff ───────────────────────────────────────────────────
# Pull the earn + penalty + note category names from src/tools/ledger.ts and
# from the category string union in LEDGER.md, diff them. Presence in either
# that isn't in the other is a failure.
echo "== category enum drift =="

code_cats=$({
  # Earn whitelist keys (`  foo: [...]` lines inside each TIER_*_EARN block).
  awk '/^const TIER_[ABC]_EARN:/{f=1;next} f && /^};/{f=0} f' src/tools/ledger.ts \
    | grep -oE "^  [a-z_]+:" | tr -d ' :'
  # PENALTY_CATEGORIES array (multi-line).
  awk '/^export const PENALTY_CATEGORIES/{f=1;next} f && /\] as const;/{f=0} f' src/tools/ledger.ts \
    | grep -oE "'[a-z_]+'" | tr -d "'"
  # NOTE_CATEGORIES array (single-line).
  grep -E '^export const NOTE_CATEGORIES' src/tools/ledger.ts \
    | grep -oE "'[a-z_]+'" | tr -d "'"
  # Spend categories referenced implicitly by ledgerAppend (not enumerated in a TS const).
  printf "%s\n" infra service tool other
} | sort -u)

doc_cats=$(
  # Only parse the `"category":` string-union line in LEDGER.md.
  grep -E '^\s*"category":' LEDGER.md \
    | grep -oE '"[a-z_]+"' \
    | tr -d '"' \
    | grep -vE '^category$' \
    | sort -u
)

missing_in_doc=$(comm -23 <(echo "$code_cats") <(echo "$doc_cats"))
missing_in_code=$(comm -13 <(echo "$code_cats") <(echo "$doc_cats"))

if [ -n "$missing_in_doc" ]; then
  err "Categories in code but missing from LEDGER.md enum:"
  echo "$missing_in_doc" | sed 's/^/    - /'
fi
if [ -n "$missing_in_code" ]; then
  err "Categories in LEDGER.md but not in code (earn/penalty/note/meta):"
  echo "$missing_in_code" | sed 's/^/    - /'
fi
[ -z "$missing_in_doc" ] && [ -z "$missing_in_code" ] && ok "category enum agrees with code"

# ── 2. Tier-jargon leak in soul files ──────────────────────────────────────
# W0.x / W1.x / W2.x workstream jargon is gone. Any reappearance is a bug.
# (We don't grep for "Tier N" here — tier mechanics ARE documented in
# SOUL.md and LEDGER.md as internal plumbing. The outbound-only rule is
# enforced at runtime in heartbeat_loop.ts.)
echo "== workstream jargon in soul files =="

jargon_hits=$(grep -nE '\bW[0-3]\.[0-9]\b' SOUL.md PLAYBOOK.md HEARTBEAT.md MEMORY.md 2>/dev/null || true)
if [ -n "$jargon_hits" ]; then
  err "W0.x/W1.x/W2.x workstream jargon leaked back into soul files:"
  echo "$jargon_hits" | sed 's/^/    /'
else
  ok "no W0.x/W1.x/W2.x workstream jargon in soul files"
fi

# ── 3. Stale model IDs ─────────────────────────────────────────────────────
# Only `kimi-k2.5` and `moonshotai/Kimi-K2.5` are valid. `K2-Thinking` /
# `k2-thinking` are retired.
echo "== stale model IDs =="

# Scan every top-level markdown except DECISIONS.md (historical ADRs may
# reference retired IDs) and CLAUDE_CODE_PROMPT.md (one-time setup doc).
stale=$(grep -nEi 'k2[- ]thinking|Kimi-K2-Thinking' \
  SOUL.md IDENTITY.md AGENTS.md USER.md TOOLS.md HEARTBEAT.md MEMORY.md \
  PLAYBOOK.md LEDGER.md ROSTER.md SECURITY.md CONTACTS.md README.md \
  RELATIONSHIPS.md COMMITMENTS.md CLAUDE.md DEPLOY.md 2>/dev/null || true)

if [ -n "$stale" ]; then
  err "Stale K2-Thinking model ID references:"
  echo "$stale" | sed 's/^/    /'
else
  ok "no stale K2-Thinking model IDs in current-docs"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "doc_code_drift_check: FAIL"
  exit 1
fi
echo "doc_code_drift_check: PASS"
