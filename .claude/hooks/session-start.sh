#!/bin/bash
# Installs npm dependencies so `npm run check` (tsc) and `npm test` work in
# Claude Code on the web sessions. Runs only in the remote environment.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Run in the background so the session starts without waiting for the
# install; tests or tsc run in the first minutes may need to wait for it.
echo '{"async": true, "asyncTimeout": 300000}'

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install (not npm ci) reuses the cached node_modules between sessions.
npm install --no-audit --no-fund
