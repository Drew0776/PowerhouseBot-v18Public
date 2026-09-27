#!/bin/bash
# PostToolUse hook for Write|Edit: type-checks the project (tsc, the repo's
# only linter) after a .ts/.tsx file changes. On errors it exits 2 so the
# tsc output goes back to Claude to fix; otherwise it stays silent.
set -uo pipefail

file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.file_path)||(j.tool_response&&j.tool_response.filePath)||"")}catch{}})')

case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
# Dependencies not installed yet (e.g. a fresh checkout): nothing to check with.
[ -x node_modules/.bin/tsc ] || exit 0

if ! out=$(node_modules/.bin/tsc --noEmit 2>&1); then
  echo "Type check failed after editing $file:" >&2
  echo "$out" | head -40 >&2
  exit 2
fi
