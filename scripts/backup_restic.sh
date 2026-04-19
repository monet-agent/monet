#!/bin/bash
# Nightly restic backup to Cloudflare R2.
# Runs at 03:00 ET via Fly.io scheduled machine or system cron.
# Note: the encrypted journal IS backed up (ciphertext is useless without the
# destroyed private key). MEMORY.md and ledger.jsonl are also backed up normally.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:?R2_ACCOUNT_ID must be set}"
R2_BUCKET="${R2_BUCKET:?R2_BUCKET must be set}"
AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID must be set}"
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY must be set}"

export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY

REPO="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/restic"
RESTIC_PASSWORD="${RESTIC_PASSWORD:?RESTIC_PASSWORD must be set}"
export RESTIC_PASSWORD

echo "[backup] Starting restic backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Initialise repo if first run (idempotent)
restic -r "$REPO" snapshots >/dev/null 2>&1 || restic -r "$REPO" init

# Back up the full data directory
restic -r "$REPO" backup \
  --verbose \
  --tag "monet-nightly" \
  "${DATA_DIR}"

# Keep 30 daily, 8 weekly, 3 monthly
restic -r "$REPO" forget \
  --prune \
  --keep-daily 30 \
  --keep-weekly 8 \
  --keep-monthly 3

echo "[backup] Backup complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
