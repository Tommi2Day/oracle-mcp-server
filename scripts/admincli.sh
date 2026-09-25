#!/usr/bin/env bash
# Admin CLI for oracle-mcp-server
#
# Prerequisites:
#   AUTH_TOKEN  – Admin token (env var or .env file)
#   MCP_URL     – Server URL (default: http://localhost:3000)
#
# Usage:
#   ./admincli.sh list-tokens
#   ./admincli.sh show-token    <id>
#   ./admincli.sh add-token    <name>
#   ./admincli.sh delete-token <id>
#   ./admincli.sh enable-token  <id>
#   ./admincli.sh disable-token <id>
#   ./admincli.sh rename-token  <id> <new-name>
#   ./admincli.sh set-conn     <id> '<json>'   # set per-token DB connection
#   ./admincli.sh clear-conn   <id>            # reset to default admin connection
#   ./admincli.sh health                        # server health check
set -eo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$(dirname "$0")/.env"; set +a
fi

ADMIN_TOKEN="${AUTH_TOKEN:-}"
BASE_URL="${MCP_URL:-http://localhost:3000}"
API="${BASE_URL}/admin/tokens"

# ── Helpers ───────────────────────────────────────────────────────────────────
die()  { echo "❌ $*" >&2; exit 1; }
info() { echo "ℹ️  $*"; }

require_token() {
  [ -n "$ADMIN_TOKEN" ] || die "AUTH_TOKEN not set.\nExport: export AUTH_TOKEN=<admin-token>\nOr add it to scripts/.env."
}

# curl with auth header; returns HTTP body + status code
api() {
  local method="$1"; shift
  local url="$1";    shift
  curl -sS -w "\n%{http_code}" \
    -X "$method" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@" "$url"
}

# Separates body and status code (last line)
check_response() {
  local raw="$1"
  local status
  status=$(echo "$raw" | tail -n1)
  local body
  body=$(echo "$raw" | head -n -1)

  if [ "$status" -ge 400 ]; then
    local msg
    msg=$(echo "$body" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4)
    die "HTTP ${status}: ${msg:-$body}"
  fi
  echo "$body"
}

# Minimal JSON pretty-print without external tools
pretty() {
  if command -v python3 >/dev/null 2>&1; then
    echo "$1" | python3 -m json.tool 2>/dev/null || echo "$1"
  elif command -v python >/dev/null 2>&1; then
    echo "$1" | python -m json.tool 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

# ── JSON helpers ──────────────────────────────────────────────────────────────
# Requires python3 for reliable JSON parsing; falls back to grep for list view.
_py3() { command -v python3 >/dev/null 2>&1; }

# ── Subcommands ───────────────────────────────────────────────────────────────
cmd_list_tokens() {
  require_token
  local raw body
  raw=$(api GET "$API")
  body=$(check_response "$raw")

  echo ""
  if _py3; then
    printf "%-5s %-30s %-8s %-6s %-24s %-24s\n" "ID" "NAME" "ACTIVE" "CONN" "CREATED" "LAST USED"
    printf "%-5s %-30s %-8s %-6s %-24s %-24s\n" "-----" "------------------------------" "--------" "------" "------------------------" "------------------------"
    python3 - "$body" <<'PYEOF'
import sys, json
tokens = json.loads(sys.argv[1]).get("tokens", [])
for t in tokens:
    conn = "yes" if t.get("connection") else "-"
    last = (t.get("last_used_at") or "-")[:19]
    print(f"{t['id']:<5} {t['name']:<30} {str(t['active']).lower():<8} {conn:<6} {t['created_at'][:19]:<24} {last:<24}")
PYEOF
  else
    printf "%-5s %-30s %-8s %-24s %-24s\n" "ID" "NAME" "ACTIVE" "CREATED" "LAST USED"
    printf "%-5s %-30s %-8s %-24s %-24s\n" "-----" "------------------------------" "--------" "------------------------" "------------------------"
    echo "$body" | grep -o '"id":[0-9]*\|"name":"[^"]*"\|"active":[^,}]*\|"created_at":"[^"]*"\|"last_used_at":[^,}]*' | \
    awk '
      /^"id":/ { id=substr($0,6) }
      /^"name":/ { gsub(/"name":"/, ""); gsub(/"/, ""); name=$0 }
      /^"active":/ { gsub(/"active":/, ""); active=$0 }
      /^"created_at":/ { gsub(/"created_at":"/, ""); gsub(/"/, ""); created=$0 }
      /^"last_used_at":/ {
        val=substr($0,15); gsub(/"/, "", val)
        last = (val == "null" || val == "") ? "-" : val
        printf "%-5s %-30s %-8s %-24s %-24s\n", id, name, active, substr(created,1,19), substr(last,1,19)
      }
    '
  fi
  echo ""
}

cmd_show_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh show-token <id>"
  local id="$1"

  local raw body
  raw=$(api GET "$API")
  body=$(check_response "$raw")

  if _py3; then
    python3 - "$body" "$id" <<'PYEOF'
import sys, json
tokens = json.loads(sys.argv[1]).get("tokens", [])
tid = int(sys.argv[2])
t = next((x for x in tokens if x["id"] == tid), None)
if not t:
    print(f"❌ Token {tid} not found.", file=sys.stderr); sys.exit(1)
print(f"\n  ID         : {t['id']}")
print(f"  Name       : {t['name']}")
print(f"  Active     : {t['active']}")
print(f"  Created    : {t['created_at']}")
print(f"  Last used  : {t.get('last_used_at') or '-'}")
conn = t.get("connection")
if conn:
    if conn.get("tns_alias"):
        target = f"TNS alias {conn['tns_alias']}"
    elif conn.get("connect_string"):
        target = conn["connect_string"]
    elif conn.get("host"):
        target = f"{conn.get('protocol','tcp')}://{conn['host']}:{conn.get('port',1521)}/{conn.get('service_name') or conn.get('sid') or ''}"
    else:
        target = "(server default target)"
    print(f"  Connection : {target} (user: {conn.get('user','(default)')})")
    for k in ("tns_admin", "wallet_location", "ssl_server_dn_match", "ssl_server_cert_dn"):
        if k in conn:
            print(f"  {k:<11}: {conn[k]}")
else:
    print(f"  Connection : (default admin connection)")
print("")
PYEOF
  else
    # Fallback: just pretty-print filtered JSON
    echo "$body" | grep -o "\"id\":${id}[^}]*}" || die "Token ${id} not found."
  fi
}

cmd_health() {
  local raw
  raw=$(curl -sS -w "\n%{http_code}" "${BASE_URL}/health")
  local status body
  status=$(echo "$raw" | tail -n1)
  body=$(echo "$raw" | head -n -1)
  if [ "$status" -ge 400 ]; then
    die "HTTP ${status}: ${body}"
  fi
  if _py3; then
    python3 - "$body" <<'PYEOF'
import sys, json
d = json.loads(sys.argv[1])
status = "✅ ok" if d.get("status") == "ok" else f"⚠️  {d.get('status','unknown')}"
tls    = "yes" if d.get("tls") else "no"
print(f"\n  Status : {status}")
print(f"  TLS    : {tls}\n")
PYEOF
  else
    echo "$body"
  fi
}

# Escapes a value for use inside a JSON string.
json_str() {
  local v="${1//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '"%s"' "$v"
}

cmd_add_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh add-token <name> [connection options] (see help)"
  local name="$1"; shift

  # Flags take precedence over ORA_* env vars
  local host="${ORA_HOST:-}" port="${ORA_PORT:-}" service="${ORA_SERVICE_NAME:-}" sid="${ORA_SID:-}"
  local protocol="${ORA_PROTOCOL:-}" alias="${ORA_TNS_ALIAS:-}" cs="${ORA_CONNECT_STRING:-}"
  local user="${ORA_USER:-}" pass="${ORA_PASSWORD:-}" tnsadmin="" wallet="" walletpw="" diag="" tuning=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --host)            host="$2";     shift 2 ;;
      --port)            port="$2";     shift 2 ;;
      --service)         service="$2";  shift 2 ;;
      --sid)             sid="$2";      shift 2 ;;
      --protocol)        protocol="$2"; shift 2 ;;
      --tns-alias)       alias="$2";    shift 2 ;;
      --connect-string)  cs="$2";       shift 2 ;;
      --user)            user="$2";     shift 2 ;;
      --password)        pass="$2";     shift 2 ;;
      --tns-admin)       tnsadmin="$2"; shift 2 ;;
      --wallet)          wallet="$2";   shift 2 ;;
      --wallet-password) walletpw="$2"; shift 2 ;;
      --diagnostics-pack) diag="$2";    shift 2 ;;
      --tuning-pack)     tuning="$2";   shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  local fields=() target=""
  if [ -n "$cs" ]; then
    fields+=("\"connect_string\": $(json_str "$cs")"); target="$cs"
  elif [ -n "$alias" ]; then
    fields+=("\"tns_alias\": $(json_str "$alias")"); target="TNS alias $alias"
  elif [ -n "$host" ]; then
    fields+=("\"host\": $(json_str "$host")")
    [ -n "$port" ]     && fields+=("\"port\": ${port}")
    [ -n "$service" ]  && fields+=("\"service_name\": $(json_str "$service")")
    [ -n "$sid" ]      && fields+=("\"sid\": $(json_str "$sid")")
    [ -n "$protocol" ] && fields+=("\"protocol\": $(json_str "$protocol")")
    target="${protocol:-tcp}://${host}:${port:-1521}/${service:-$sid}"
  fi
  [ -n "$user" ]     && fields+=("\"user\": $(json_str "$user")")
  [ -n "$pass" ]     && fields+=("\"password\": $(json_str "$pass")")
  [ -n "$tnsadmin" ] && fields+=("\"tns_admin\": $(json_str "$tnsadmin")")
  [ -n "$wallet" ]   && fields+=("\"wallet_location\": $(json_str "$wallet")")
  [ -n "$walletpw" ] && fields+=("\"wallet_password\": $(json_str "$walletpw")")
  case "$diag" in true|false) fields+=("\"diagnostics_pack\": $diag") ;; "") ;; *) die "--diagnostics-pack must be true or false" ;; esac
  case "$tuning" in true|false) fields+=("\"tuning_pack\": $tuning") ;; "") ;; *) die "--tuning-pack must be true or false" ;; esac

  local conn_json=""
  if [ ${#fields[@]} -gt 0 ]; then
    local IFS=","
    conn_json=",\"connection\": {${fields[*]}}"
  fi

  local raw body
  raw=$(api POST "$API" -d "{\"name\":$(json_str "$name")${conn_json}}")
  body=$(check_response "$raw")

  local token
  token=$(echo "$body" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  local id
  id=$(echo "$body" | grep -o '"id":[0-9]*' | cut -d':' -f2)

  echo ""
  echo "✅ Token created (ID: ${id}, Name: ${name})"
  echo ""
  echo "   TOKEN (shown once – copy it now!):"
  echo ""
  echo "   ${token}"
  echo ""
  echo "   .mcp.json entry:"
  echo "   \"headers\": { \"Authorization\": \"Bearer ${token}\" }"
  echo ""
  if [ -n "$conn_json" ]; then
    echo "   Connection: ${target:-(server default target)} (user: ${user:-(default)})"
    echo ""
  fi
}

cmd_delete_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh delete-token <id>"
  local id="$1"

  local raw body
  raw=$(api DELETE "${API}/${id}")
  body=$(check_response "$raw")
  echo "✅ Token ${id} deleted."
}

cmd_enable_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh enable-token <id>"
  local id="$1"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d '{"active":true}')
  body=$(check_response "$raw")
  echo "✅ Token ${id} enabled."
}

cmd_disable_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh disable-token <id>"
  local id="$1"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d '{"active":false}')
  body=$(check_response "$raw")
  echo "✅ Token ${id} disabled."
}

cmd_rename_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh rename-token <id> <new-name>"
  [ -n "${2:-}" ] || die "Usage: ./admincli.sh rename-token <id> <new-name>"
  local id="$1" name="$2"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d "{\"name\":\"${name}\"}")
  body=$(check_response "$raw")
  echo "✅ Token ${id} renamed to \"${name}\"."
}

cmd_set_conn() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh set-conn <id> '<json>'"
  [ -n "${2:-}" ] || die "Usage: ./admincli.sh set-conn <id> '<json>'"
  local id="$1" json="$2"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d "{\"connection\":${json}}")
  body=$(check_response "$raw")
  echo "✅ Token ${id} connection updated."
  pretty "$body"
}

cmd_clear_conn() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh clear-conn <id>"
  local id="$1"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d '{"connection":null}')
  body=$(check_response "$raw")
  echo "✅ Token ${id} connection cleared (uses default admin connection)."
}

cmd_help() {
  cat <<EOF

oracle-mcp-server admin CLI

  Configuration (env vars or scripts/.env):
    AUTH_TOKEN   Admin token (required for token commands)
    MCP_URL      Server URL  (default: http://localhost:3000)

  Server commands (no AUTH_TOKEN needed):
    health                       Show server health status

  Token commands:
    list-tokens                  List all tokens
    show-token   <id>            Show details of a single token (incl. connection)
    add-token    <name>          Create a new token; optional per-token connection
                                 (flags take precedence over ORA_* env vars,
                                 omit all to use the server's default connection):
               [--connect-string S]   Easy Connect, descriptor, alias or JDBC URL
               [--tns-alias A]        alias from tnsnames.ora
               [--host H] [--port P] [--service S | --sid S] [--protocol tcp|tcps]
               [--user U] [--password P]
               [--tns-admin DIR]      directory with tnsnames.ora (inside the container)
               [--wallet DIR] [--wallet-password P]
               [--diagnostics-pack true|false]   licensed → ASH/AWR tools (default: server setting)
               [--tuning-pack true|false]        licensed → SQL Monitor tool (default: server setting)
    delete-token <id>            Permanently delete a token
    enable-token <id>            Re-enable a token
    disable-token <id>           Temporarily disable a token
    rename-token <id> <name>     Rename a token
    set-conn     <id> '<json>'   Set a custom DB connection for a token (omitted password is kept)
                                 JSON: {"tns_alias":"PROD","user":"u","password":"p"}
    clear-conn   <id>            Clear per-token connection (falls back to default connection)

  Examples:
    export AUTH_TOKEN=<admin-token>
    ./admincli.sh health
    ./admincli.sh list-tokens
    ./admincli.sh add-token "claude-desktop"

    # Host / port / service over TCPS
    ./admincli.sh add-token "reporting" --host db.example.com --port 2484 --protocol tcps \
      --service REPORTS --user report_ro --password secret

    # TNS alias from the mounted tnsnames.ora
    ./admincli.sh add-token "prod" --tns-alias PROD_HIGH --user app --password secret

    # JDBC URL (credentials in the URL are moved to user/password and encrypted at rest)
    ./admincli.sh add-token "legacy" --connect-string 'jdbc:oracle:thin:@dbhost:1521:ORCL' --user scott --password tiger

    # Update connection on existing token
    ./admincli.sh set-conn 2 '{"host":"db.example.com","port":1521,"service_name":"PDB1","user":"u","password":"p"}'

    # Reset to default connection
    ./admincli.sh clear-conn 2

EOF
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "${1:-help}" in
  list-tokens)   cmd_list_tokens ;;
  show-token)    cmd_show_token    "${2:-}" ;;
  add-token)     cmd_add_token     "${@:2}" ;;
  delete-token)  cmd_delete_token  "${2:-}" ;;
  enable-token)  cmd_enable_token  "${2:-}" ;;
  disable-token) cmd_disable_token "${2:-}" ;;
  rename-token)  cmd_rename_token  "${2:-}" "${3:-}" ;;
  set-conn)      cmd_set_conn      "${2:-}" "${3:-}" ;;
  clear-conn)    cmd_clear_conn    "${2:-}" ;;
  health)        cmd_health ;;
  help|--help|-h) cmd_help ;;
  *) die "Unknown command: ${1}\nHelp: ./admincli.sh help" ;;
esac
