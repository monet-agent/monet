FROM node:24-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
COPY scripts/ ./scripts/
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
# Soul docs are needed by scripts/doc_code_drift_check.sh (runs in build).
COPY SOUL.md IDENTITY.md AGENTS.md USER.md TOOLS.md HEARTBEAT.md \
     MEMORY.md PLAYBOOK.md LEDGER.md ROSTER.md SECURITY.md CONTACTS.md \
     DECISIONS.md RELATIONSHIPS.md COMMITMENTS.md README.md CLAUDE.md \
     DEPLOY.md ./
RUN npm run build

# ── Runtime image ────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

# Install restic (nightly backup) and iptables (egress filtering)
RUN apt-get update && apt-get install -y --no-install-recommends \
      restic \
      iptables \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# flyctl binary — used by fly_mvp tools for autonomous MVP deploys to the
# pre-provisioned app pool (monet-mvp-01..NN). Token scoping is per-app so
# this flyctl install can only act on slots listed in FLY_MVP_TOKENS.
RUN curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh && \
    /usr/local/bin/flyctl version

# node:24-slim already has node user at uid/gid 1000 — rename it to monet
RUN usermod -l monet node && groupmod -n monet node

# App directory (owned by root, read-only at runtime for non-data files)
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY scripts/ ./scripts/
COPY openclaw.json ./

# Soul files (read by the heartbeat loop at runtime from DATA_DIR)
# These are baked in as defaults; on Fly.io the persistent volume at /data
# is the live copy. The entrypoint syncs these to /data on first boot.
COPY SOUL.md IDENTITY.md AGENTS.md USER.md TOOLS.md HEARTBEAT.md \
     MEMORY.md PLAYBOOK.md LEDGER.md ROSTER.md SECURITY.md CONTACTS.md \
     DECISIONS.md RELATIONSHIPS.md COMMITMENTS.md README.md ./soul_files/

# Copy memory defaults
COPY memory/ ./soul_files/memory/

# OpenClaw config
RUN mkdir -p /home/monet/.openclaw && \
    cp /app/openclaw.json /home/monet/.openclaw/openclaw.json && \
    chown -R monet:monet /home/monet/.openclaw

# Entrypoint (runs as root to set up iptables, then drops to uid 1000)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Data volume — persistent state lives here
RUN mkdir -p /data/memory /data/memory/daily /data/memory/subagents && \
    chown -R monet:monet /data

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
