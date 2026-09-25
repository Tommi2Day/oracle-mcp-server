#!/usr/bin/env bash
# Runs unit tests via Docker (no local Node.js required)
#
# Usage:
#   ./test.sh                        # all tests
#   ./test.sh tests/lib.test.ts      # single file
#   ./test.sh --reporter=verbose     # vitest options
set -eo pipefail

# pwd -W returns Windows paths (C:/...) in Git Bash – required for Docker volume mounts
DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

docker run --rm \
  -v "${DIR}:/app" \
  -v "oracle-mcp-npm-cache:/root/.npm" \
  node:24-alpine \
  sh -c 'cd /app && npm ci --silent && npx vitest run "$@"' -- "$@"
