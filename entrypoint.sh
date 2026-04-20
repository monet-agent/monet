#!/bin/sh
# Entrypoint: runs as root, sets up iptables + volume, then drops to uid 1000.
set -e

DATA_DIR="${DATA_DIR:-/data}"

# ── 1. Sync soul files to persistent volume ──────────────────────────────
# Stateless config files are ALWAYS overwritten from the image — they're
# the declared behavior of monet and are source-controlled in git.
# Stateful files (MEMORY.md, DECISIONS.md, RELATIONSHIPS.md, ROSTER.md,
# COMMITMENTS.md, LEDGER.md) are only seeded on first boot — monet and
# Damian edit them in place and their content is the running state.
# NOTE: LEDGER.md is intentionally NOT stateful. Monet never writes to it;
# it's pure policy documentation. Keeping it stateful meant rule changes
# couldn't ship via deploy. ledger.jsonl is the actual state.
STATEFUL_FILES="MEMORY.md DECISIONS.md RELATIONSHIPS.md ROSTER.md COMMITMENTS.md"

is_stateful() {
  case " $STATEFUL_FILES " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

for f in /app/soul_files/*.md; do
  fname=$(basename "$f")
  dest="${DATA_DIR}/${fname}"
  if is_stateful "$fname"; then
    if [ ! -f "$dest" ]; then
      cp "$f" "$dest"
      echo "[entrypoint] seeded stateful ${fname}"
    fi
  else
    cp "$f" "$dest"
    echo "[entrypoint] synced ${fname}"
  fi
done

# ── 1b. Fetch fresh soul files from GitHub (post-image override) ──────────
# Non-stateful soul files can be updated by pushing to GitHub and restarting
# the machine — no redeploy needed. Stateful files are never fetched.
SOUL_REPO="${SOUL_REPO:-monet-agent/monet}"
RAW_BASE="https://raw.githubusercontent.com/${SOUL_REPO}/main"
FETCH_TIMEOUT=10

for f in /app/soul_files/*.md; do
  fname=$(basename "$f")
  if is_stateful "$fname"; then
    continue
  fi
  dest="${DATA_DIR}/${fname}"
  tmp="${dest}.fetching"
  if curl -sf --max-time "${FETCH_TIMEOUT}" "${RAW_BASE}/${fname}" -o "${tmp}" 2>/dev/null; then
    mv "${tmp}" "${dest}"
    echo "[entrypoint] fetched ${fname} from GitHub"
  else
    rm -f "${tmp}"
    echo "[entrypoint] WARNING: could not fetch ${fname} from GitHub — using baked-in copy"
  fi
done

# Ensure inbox.md exists so heartbeat loader doesn't skip it silently.
if [ ! -f "${DATA_DIR}/memory/inbox.md" ]; then
  mkdir -p "${DATA_DIR}/memory"
  printf '# Inbox — messages from Damian to mon€t\n\nAppend new instructions to the bottom of this file. Each entry should start with a timestamp line (`## <ISO timestamp> — from Damian`) and end with `---`.\n\nAfter mon€t has addressed an entry, it should rewrite the file to remove handled items, keeping only un-addressed instructions.\n\n_(No pending instructions.)_\n' > "${DATA_DIR}/memory/inbox.md"
  echo "[entrypoint] seeded memory/inbox.md"
fi

# Seed memory directory (don't overwrite if volume already has entries)
if [ ! -f "${DATA_DIR}/memory/journal.md" ]; then
  cp -r /app/soul_files/memory/. "${DATA_DIR}/memory/"
  echo "[entrypoint] seeded memory/"
fi

if [ ! -f "${DATA_DIR}/ledger.jsonl" ]; then
  echo "[entrypoint] creating empty ledger.jsonl"
  touch "${DATA_DIR}/ledger.jsonl"
fi

if [ ! -f "${DATA_DIR}/memory/public_log.md" ]; then
  echo "# Public Log" > "${DATA_DIR}/memory/public_log.md"
fi

chown -R monet:monet "${DATA_DIR}" 2>/dev/null || true

# ── 2. Apply chattr +a (append-only) where supported ─────────────────────
chattr +a "${DATA_DIR}/ledger.jsonl" 2>/dev/null || \
  echo "[entrypoint] chattr +a not supported on this filesystem (documented in DEPLOY.md)"
chattr +a "${DATA_DIR}/memory/public_log.md" 2>/dev/null || true
# Note: memory/journal.md.age is append-only by design (chattr not needed for .age)

# ── 3. Set up iptables egress allowlist ──────────────────────────────────
setup_iptables() {
  echo "[entrypoint] configuring egress iptables allowlist..."

  # Flush OUTPUT chain rules
  iptables -F OUTPUT || true

  # Allow loopback
  iptables -A OUTPUT -o lo -j ACCEPT

  # Allow established/related (replies to inbound connections)
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Allow DNS (needed to resolve domains)
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

  # Resolve and allow each permitted egress domain.
  # Note: IPs can change (CDNs). The DEPLOY.md documents a refresh strategy.
  ALLOWED_DOMAINS="
    api.deepinfra.com
    api.moonshot.ai
    hc-ping.com
    www.moltbook.com
    moltbook.com
    clawhub.ai
    api.basescan.org
    api.etherscan.io
    api.stripe.com
    r2.cloudflarestorage.com
    api.github.com
    raw.githubusercontent.com
    api.telegram.org
    api.e2b.dev
    e2b.dev
    api.cdp.coinbase.com
    mainnet.base.org
  "

  for domain in $ALLOWED_DOMAINS; do
    # IPv4 only — `iptables` can't hold IPv6 addresses. We also drop all
    # IPv6 egress below via ip6tables, so Node's happy-eyeballs falls to v4.
    ips=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)
    for ip in $ips; do
      iptables -A OUTPUT -d "$ip" -j ACCEPT
    done
  done

  # NOTE: DROP disabled — Fly's DNS resolution has been producing
  # persistent EAI_AGAIN with the allowlist enforced. The ACCEPT rules
  # above still serve as documentation of allowed egress; re-enable the
  # DROP once we've isolated why DNS fails under the filter.
  # iptables -A OUTPUT -j DROP

  echo "[entrypoint] iptables allowlist applied (DROP disabled — permissive mode)"
}

setup_ip6tables() {
  # We do not maintain a v6 allowlist. Drop all IPv6 egress so Node
  # reliably falls back to IPv4 (where the allowlist lives).
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -F OUTPUT || true
    ip6tables -A OUTPUT -o lo -j ACCEPT
    ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # DNS over v6 — resolv.conf on Fly often has v6 nameservers; blocking
    # these causes EAI_AGAIN on all lookups.
    ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT
    ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT
    # DROP disabled for now — see IPv4 note above.
    # ip6tables -A OUTPUT -j DROP
    echo "[entrypoint] ip6tables: permissive mode"
  fi
}

if command -v iptables >/dev/null 2>&1; then
  setup_iptables || echo "[entrypoint] WARNING: iptables setup failed — egress not filtered"
  setup_ip6tables || true
else
  echo "[entrypoint] WARNING: iptables not available — egress not filtered (document in DEPLOY.md)"
fi

# Force Node to prefer IPv4 (belt-and-suspenders alongside ip6tables drop).
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"

# ── 4. Wait for DNS to be ready ──────────────────────────────────────────
# Fly machines can start firing the app before the resolver is warm,
# which produces a cascade of EAI_AGAIN on the first heartbeat. Block
# until we can resolve a known host, or 30s, whichever comes first.
echo "[entrypoint] waiting for DNS..."
i=0
while [ $i -lt 30 ]; do
  if getent ahostsv4 api.moonshot.ai >/dev/null 2>&1; then
    echo "[entrypoint] DNS ready after ${i}s"
    break
  fi
  i=$((i + 1))
  sleep 1
done

# ── 5. Drop to uid 1000 and run the agent ────────────────────────────────
echo "[entrypoint] dropping to uid 1000 (monet)"
exec su -s /bin/sh monet -c "NODE_OPTIONS='--dns-result-order=ipv4first' node /app/dist/main.js"
