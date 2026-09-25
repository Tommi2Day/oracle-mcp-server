#!/usr/bin/env bash
# Validates a MCP token: connects to the server and lists available tables.
#
# Usage:
#   ./test_token.sh <token> [schema]
#
# Configuration (env var or scripts/.env):
#   MCP_URL  – Server URL (default: http://localhost:3000)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

# ── Load .env if present ──────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi

TOKEN="${1:-}"
SCHEMA="${2:-}"
if [ -n "$SCHEMA" ]; then TOOL_ARGS="{\"schema\":\"$SCHEMA\"}"; else TOOL_ARGS="{}"; fi
BASE_URL="${MCP_URL:-http://localhost:3000}"
CLIENT_IP="${X_REAL_IP:-$( (hostname -i 2>/dev/null || true) | awk '{print $1}')}"

die() { echo "❌ $*" >&2; exit 1; }
ok()  { echo "✅ $*"; }

[ -n "$TOKEN" ] || die "No token provided.\nUsage: ./test_token.sh <token> [schema]"

# ── MCP request ───────────────────────────────────────────────────────────────
# MCP Streamable HTTP requires separate POST requests – batching initialize
# together with other methods is not allowed.
echo "ℹ️  Testing token against $BASE_URL (schema: ${SCHEMA:-current}) ..."

MCP_HEADERS=(
  -H "Authorization: Bearer $TOKEN"
  -H "Content-Type: application/json"
  -H "Accept: application/json, text/event-stream"
)
[ -n "$CLIENT_IP" ] && MCP_HEADERS+=(-H "X-Real-IP: $CLIENT_IP")

# Step 1: initialize — use -D - to capture response headers in output
RAW=$(curl -sS -D - -w "\n%{http_code}" -X POST "$BASE_URL/mcp" \
  "${MCP_HEADERS[@]}" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{
      "protocolVersion":"2024-11-05",
      "capabilities":{},
      "clientInfo":{"name":"test_token.sh","version":"1.0"}
    }
  }' 2>&1) || die "curl failed – server unreachable: $BASE_URL"

STATUS=$(echo "$RAW" | tail -n1)
# headers = lines up to first blank line; body = everything after
HEADERS=$(echo "$RAW" | awk '/^$/{exit} {print}')
BODY=$(echo "$RAW" | awk 'found{print} /^$/{found=1}' | head -n -1)

# ── Auth / connectivity check on initialize ───────────────────────────────────
case "$STATUS" in
  000) die "Server unreachable: $BASE_URL\nIs the server running? (docker ps / docker compose ps)" ;;
  401) die "Token invalid or expired (HTTP 401).\nCheck tokens: ./admincli.sh list-tokens" ;;
  403) die "Token not authorized for /mcp (HTTP 403)." ;;
  503) die "Server error (HTTP 503): AUTH_TOKEN not configured on the server." ;;
  200) ;; # ok, continue
  *)   die "Unexpected HTTP status $STATUS on initialize:\n$BODY" ;;
esac

# Extract session ID from response headers (present when server is stateful)
SESSION_ID=$(echo "$HEADERS" | grep -i "^mcp-session-id:" | tr -d '\r' | awk '{print $2}')
SESSION_HEADER=()
[ -n "$SESSION_ID" ] && SESSION_HEADER=(-H "mcp-session-id: $SESSION_ID")

# Step 2: notifications/initialized (fire-and-forget, ignore response)
curl -sS -o /dev/null -X POST "$BASE_URL/mcp" \
  "${MCP_HEADERS[@]}" "${SESSION_HEADER[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' 2>/dev/null || true

# Step 3: tools/call list_tables
RAW=$(curl -sS -w "\n%{http_code}" -X POST "$BASE_URL/mcp" \
  "${MCP_HEADERS[@]}" "${SESSION_HEADER[@]}" \
  -d "{
    \"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",
    \"params\":{\"name\":\"list_tables\",\"arguments\":$TOOL_ARGS}
  }" 2>&1) || die "curl failed on tools/call"

STATUS=$(echo "$RAW" | tail -n1)
BODY=$(echo "$RAW" | head -n -1)

# ── Evaluate tools/call response ─────────────────────────────────────────────
case "$STATUS" in
  200) ok "Token accepted (HTTP 200)" ;;
  *)   die "Unexpected HTTP status $STATUS on tools/call:\n$BODY" ;;
esac

# ── Extract text content from JSON or SSE response ───────────────────────────
# Handles both plain JSON and text/event-stream (data: {...} lines).
extract_text() {
  python3 - "$1" <<'PYEOF'
import sys, json

raw = sys.argv[1] if len(sys.argv) > 1 else ""

# collect candidate JSON lines (plain or SSE)
candidates = []
for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data: "):
        line = line[6:]
    if line and not line.startswith(":"):
        candidates.append(line)
# also try the whole body
candidates.append(raw)

for chunk in candidates:
    try:
        obj = json.loads(chunk)
        if isinstance(obj, list):
            obj = next((o for o in obj if isinstance(o, dict)), {})
        result = obj.get("result", {})
        for item in result.get("content", []):
            if item.get("type") == "text":
                print(item["text"], end="")
                sys.exit(0)
        # surface isError
        if obj.get("error"):
            print("__ERROR__:" + json.dumps(obj["error"].get("message", obj["error"])), end="")
            sys.exit(2)
    except (json.JSONDecodeError, AttributeError):
        pass
PYEOF
}

EXTRACTED=$(extract_text "$BODY"); EXTRACT_STATUS=$?

if [ $EXTRACT_STATUS -eq 2 ] || echo "$EXTRACTED" | grep -q '^__ERROR__:'; then
  ERR=$(echo "$EXTRACTED" | sed 's/^__ERROR__://')
  die "MCP error: $ERR"
fi

if echo "$BODY" | grep -q '"isError":true'; then
  die "MCP tool error:\n$EXTRACTED"
fi

TABLE_TEXT="$EXTRACTED"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Tables in schema: ${SCHEMA:-current}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -n "$TABLE_TEXT" ]; then
  echo "$TABLE_TEXT"
else
  echo "(no tables found or response could not be parsed)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
