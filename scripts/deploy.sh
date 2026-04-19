#!/bin/bash
# Deploy helper. Run each step manually as documented in DEPLOY.md.
# This script is a reference — do not run it blindly.

set -euo pipefail

APP_NAME="${FLY_APP_NAME:-monet-agent}"
REGION="yyz"
VOLUME_SIZE="10"

echo "mon€t deployment helper"
echo "App: ${APP_NAME} | Region: ${REGION}"
echo ""

check_fly() {
  if ! command -v fly &>/dev/null; then
    echo "ERROR: flyctl not installed. See https://fly.io/docs/hands-on/install-flyctl/"
    exit 1
  fi
  echo "✓ flyctl found: $(fly version)"
}

launch() {
  echo "=== fly launch (no deploy) ==="
  fly launch --no-deploy --name "${APP_NAME}" --region "${REGION}" --dockerfile Dockerfile
}

create_volume() {
  echo "=== Creating persistent volume ==="
  fly volumes create agent_data \
    --size "${VOLUME_SIZE}" \
    --region "${REGION}" \
    --app "${APP_NAME}"
}

set_secrets() {
  echo "=== Setting Fly secrets ==="
  echo "You must set the following secrets. Paste each value when prompted."
  echo "Run: fly secrets set -a ${APP_NAME} \\"

  cat <<'EOF'
  KIMI_API_KEY="..." \
  KIMI_FALLBACK_KEY="..." \
  HEALTHCHECK_UUID="..." \
  R2_ACCOUNT_ID="..." \
  R2_BUCKET="monet-state-backup" \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_VERIFIER_ACCESS_KEY_ID="..." \
  R2_VERIFIER_SECRET_ACCESS_KEY="..." \
  TELEGRAM_BOT_TOKEN="..." \
  TELEGRAM_CHAT_ID_DAMIAN="..." \
  TELEGRAM_CHAT_ID_JENNY="..." \
  TELEGRAM_CHAT_ID_GROUP="..." \
  MOLTBOOK_API_KEY="..." \
  RESTIC_PASSWORD="..."
EOF
}

run_ceremony() {
  echo "=== Journal setup ceremony (ONE TIME ONLY) ==="
  echo "This will:"
  echo "  1. Generate an age keypair"
  echo "  2. Write only the PUBLIC key to the volume"
  echo "  3. Immediately destroy the private key"
  echo "  4. Print the public key fingerprint for verification"
  echo ""
  echo "After this runs, past journal entries can NEVER be decrypted."
  echo ""
  read -r -p "Proceed? (yes/no): " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 0
  fi

  fly ssh console -a "${APP_NAME}" --command "node /app/scripts/journal_setup.js"
}

deploy() {
  echo "=== Deploying ==="
  fly deploy --app "${APP_NAME}"
}

grep_for_private_key() {
  echo "=== Verification: grep for private key format ==="
  echo "This should return zero results:"
  fly ssh console -a "${APP_NAME}" --command "grep -r 'AGE-SECRET-KEY-' /data /app 2>/dev/null || echo 'CLEAN — no private key found'"
}

case "${1:-help}" in
  check)   check_fly ;;
  launch)  launch ;;
  volume)  create_volume ;;
  secrets) set_secrets ;;
  ceremony) run_ceremony ;;
  deploy)  deploy ;;
  verify)  grep_for_private_key ;;
  help|*)
    echo "Commands:"
    echo "  check    - verify flyctl installed"
    echo "  launch   - fly launch --no-deploy"
    echo "  volume   - create persistent volume"
    echo "  secrets  - show fly secrets set template"
    echo "  ceremony - run journal setup (ONE TIME)"
    echo "  deploy   - fly deploy"
    echo "  verify   - grep for private key (should return nothing)"
    ;;
esac
