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
STATEFUL_FILES="MEMORY.md DECISIONS.md RELATIONSHIPS.md ROSTER.md COMMITMENTS.md LEDGER.md"

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
  "

  for domain in $ALLOWED_DOMAINS; do
    ips=$(getent hosts "$domain" 2>/dev/null | awk '{print $1}' || true)
    for ip in $ips; do
      iptables -A OUTPUT -d "$ip" -j ACCEPT
    done
  done

  # Drop everything else
  iptables -A OUTPUT -j DROP

  echo "[entrypoint] iptables allowlist applied"
}

if command -v iptables >/dev/null 2>&1; then
  setup_iptables || echo "[entrypoint] WARNING: iptables setup failed — egress not filtered"
else
  echo "[entrypoint] WARNING: iptables not available — egress not filtered (document in DEPLOY.md)"
fi

# ── 4. Drop to uid 1000 and run the agent ────────────────────────────────
echo "[entrypoint] dropping to uid 1000 (monet)"
exec su -s /bin/sh monet -c "node /app/dist/main.js"
