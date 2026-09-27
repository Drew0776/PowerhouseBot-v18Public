#!/bin/bash
# Installs npm dependencies so `npm run check` (tsc) and `npm test` work in
# Claude Code on the web sessions. Runs only in the remote environment.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# Nothing to install on a branch without the app (e.g. main before a merge).
if [ ! -f package.json ]; then
  exit 0
fi

# npm install (not npm ci) reuses the cached node_modules between sessions.
npm install --no-audit --no-fund
