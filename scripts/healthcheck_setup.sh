#!/bin/bash
# Healthchecks.io check setup helper.
# Run this manually to verify your check is configured correctly.
# The actual UUID is provisioned via the Healthchecks.io web UI.

set -euo pipefail

HEALTHCHECK_UUID="${HEALTHCHECK_UUID:?HEALTHCHECK_UUID must be set}"

echo "Testing Healthchecks.io ping..."
echo ""

echo "Sending /start..."
curl -fsS "https://hc-ping.com/${HEALTHCHECK_UUID}/start"
echo " ✓"

sleep 2

echo "Sending /ok..."
curl -fsS "https://hc-ping.com/${HEALTHCHECK_UUID}"
echo " ✓"

echo ""
echo "Healthchecks.io is configured correctly."
echo "Check UUID: ${HEALTHCHECK_UUID}"
echo "Expected period: 30 minutes"
echo "Expected grace: 10 minutes"
echo ""
echo "If the check is not showing 'up' in the dashboard, verify:"
echo "  1. Period is set to 30 minutes in the HC.io UI"
echo "  2. Grace is set to 10 minutes"
echo "  3. Your email notifications are configured"
