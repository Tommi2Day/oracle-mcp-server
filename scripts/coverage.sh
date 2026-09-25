#!/usr/bin/env bash
# Runs coverage report via Docker (no local Node.js required)
#
# Usage:
#   ./coverage.sh            # generate report (output in ./coverage/)
#   ./coverage.sh --open     # generate report and open in browser
set -eo pipefail

OPEN=false
if [ "$1" = "--open" ]; then
  OPEN=true
fi

# pwd -W returns Windows paths (C:/...) in Git Bash – required for Docker volume mounts
DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

docker run --rm \
  -v "${DIR}:/app" \
  -v "oracle-mcp-npm-cache:/root/.npm" \
  node:24-alpine \
  sh -c 'cd /app && npm ci --silent && npx vitest run --coverage'

if [ "$OPEN" = true ]; then
  REPORT="${DIR}/coverage/index.html"
  if [ -f "$REPORT" ]; then
    echo "Opening coverage report: $REPORT"
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$REPORT"
    elif command -v open >/dev/null 2>&1; then
      open "$REPORT"
    else
      start "$REPORT" 2>/dev/null || echo "Open manually: $REPORT"
    fi
  else
    echo "Coverage report not found at: $REPORT"
  fi
fi
