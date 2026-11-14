#!/usr/bin/env bash
# Admin CLI for oracle-mcp-server
#
# Prerequisites:
#   AUTH_TOKEN  – Admin token (env var or .env file); ADMIN_TOKEN is accepted as an alias.
#                 With OAuth (OAUTH_ISSUER) the access token (JWT) of a user with an admin assignment works too.
#   MCP_URL     – Server URL (default: http://localhost:3000)
#
# Usage:
#   ./admincli.sh whoami                        # who am I, how is the server secured
#   ./admincli.sh list-assignments              # OAuth assignments (group/user -> connection)
#   ./admincli.sh show-assignment   <id>
#   ./admincli.sh add-assignment    --group G | --email E [connection options] [--admin] [--client-connection M] [--note T]
#   ./admincli.sh delete-assignment <id>
#   ./admincli.sh set-assignment-conn <id> '<json>' | clear-assignment-conn <id>
#   ./admincli.sh set-assignment-client-conn <id> none|credentials|full
#   ./admincli.sh set-assignment-admin <id> true|false
#   ./admincli.sh list-tokens
#   ./admincli.sh show-token    <id>
#   ./admincli.sh add-token    <name>
#   ./admincli.sh delete-token <id>
#   ./admincli.sh enable-token  <id>
#   ./admincli.sh disable-token <id>
#   ./admincli.sh rename-token  <id> <new-name>
#   ./admincli.sh set-conn     <id> '<json>'   # set per-token DB connection
#   ./admincli.sh clear-conn   <id>            # reset to default admin connection
#   ./admincli.sh set-client-conn <id> none|credentials|full   # client may send X-Oracle-* headers
#   ./admincli.sh health                        # server health check
set -eo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$(dirname "$0")/.env"; set +a
fi

ADMIN_TOKEN="${AUTH_TOKEN:-${ADMIN_TOKEN:-}}"
BASE_URL="${MCP_URL:-http://localhost:3000}"
API="${BASE_URL}/admin/tokens"
ASSIGN_API="${BASE_URL}/admin/assignments"

# ── Helpers ───────────────────────────────────────────────────────────────────
die()  { echo "❌ $*" >&2; exit 1; }
info() { echo "ℹ️  $*"; }

require_token() {
  [ -n "$ADMIN_TOKEN" ] || die "AUTH_TOKEN not set.\nExport: export AUTH_TOKEN=<admin-token> (or the access token of an OAuth admin)\nOr add it to scripts/.env."
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

# Connection options shared by add-token and add-assignment. Flags take precedence over ORA_* env vars.
# Sets the o_* variables; "assignment" mode additionally accepts --group/--email/--admin/--note.
parse_conn_opts() {
  local mode="$1"; shift
  o_host="${ORA_HOST:-}"; o_port="${ORA_PORT:-}"; o_service="${ORA_SERVICE_NAME:-}"; o_sid="${ORA_SID:-}"
  o_protocol="${ORA_PROTOCOL:-}"; o_alias="${ORA_TNS_ALIAS:-}"; o_cs="${ORA_CONNECT_STRING:-}"
  o_user="${ORA_USER:-}"; o_pass="${ORA_PASSWORD:-}"
  o_tnsadmin=""; o_wallet=""; o_walletpw=""; o_diag=""; o_tuning=""; o_client=""
  o_group=""; o_email=""; o_admin=""; o_note=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --host)            o_host="${2:?--host needs a value}";     shift 2 ;;
      --port)            o_port="${2:?--port needs a value}";     shift 2 ;;
      --service)         o_service="${2:?--service needs a value}"; shift 2 ;;
      --sid)             o_sid="${2:?--sid needs a value}";       shift 2 ;;
      --protocol)        o_protocol="${2:?--protocol needs a value}"; shift 2 ;;
      --tns-alias)       o_alias="${2:?--tns-alias needs a value}"; shift 2 ;;
      --connect-string)  o_cs="${2:?--connect-string needs a value}"; shift 2 ;;
      --user)            o_user="${2:?--user needs a value}";     shift 2 ;;
      --password)        o_pass="${2:?--password needs a value}"; shift 2 ;;
      --tns-admin)       o_tnsadmin="${2:?--tns-admin needs a value}"; shift 2 ;;
      --wallet)          o_wallet="${2:?--wallet needs a value}"; shift 2 ;;
      --wallet-password) o_walletpw="${2:?--wallet-password needs a value}"; shift 2 ;;
      --diagnostics-pack) o_diag="${2:?--diagnostics-pack needs a value}"; shift 2 ;;
      --tuning-pack)     o_tuning="${2:?--tuning-pack needs a value}"; shift 2 ;;
      --client-connection) o_client="${2:?--client-connection needs a value}"; shift 2 ;;
      --group)  [ "$mode" = assignment ] || die "Unknown option: $1"; o_group="${2:?--group needs a value}"; shift 2 ;;
      --email)  [ "$mode" = assignment ] || die "Unknown option: $1"; o_email="${2:?--email needs a value}"; shift 2 ;;
      --note)   [ "$mode" = assignment ] || die "Unknown option: $1"; o_note="${2:?--note needs a value}"; shift 2 ;;
      --admin)  [ "$mode" = assignment ] || die "Unknown option: $1"; o_admin=true; shift ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

# Builds CONN_JSON (`,"connection": {…}` or empty) and CONN_TARGET from the o_* variables.
build_conn_json() {
  local fields=() target=""
  if [ -n "$o_cs" ]; then
    fields+=("\"connect_string\": $(json_str "$o_cs")"); target="$o_cs"
  elif [ -n "$o_alias" ]; then
    fields+=("\"tns_alias\": $(json_str "$o_alias")"); target="TNS alias $o_alias"
  elif [ -n "$o_host" ]; then
    fields+=("\"host\": $(json_str "$o_host")")
    [ -n "$o_port" ]     && fields+=("\"port\": ${o_port}")
    [ -n "$o_service" ]  && fields+=("\"service_name\": $(json_str "$o_service")")
    [ -n "$o_sid" ]      && fields+=("\"sid\": $(json_str "$o_sid")")
    [ -n "$o_protocol" ] && fields+=("\"protocol\": $(json_str "$o_protocol")")
    target="${o_protocol:-tcp}://${o_host}:${o_port:-1521}/${o_service:-$o_sid}"
  fi
  [ -n "$o_user" ]     && fields+=("\"user\": $(json_str "$o_user")")
  [ -n "$o_pass" ]     && fields+=("\"password\": $(json_str "$o_pass")")
  [ -n "$o_tnsadmin" ] && fields+=("\"tns_admin\": $(json_str "$o_tnsadmin")")
  [ -n "$o_wallet" ]   && fields+=("\"wallet_location\": $(json_str "$o_wallet")")
  [ -n "$o_walletpw" ] && fields+=("\"wallet_password\": $(json_str "$o_walletpw")")
  case "$o_diag" in true|false) fields+=("\"diagnostics_pack\": $o_diag") ;; "") ;; *) die "--diagnostics-pack must be true or false" ;; esac
  case "$o_tuning" in true|false) fields+=("\"tuning_pack\": $o_tuning") ;; "") ;; *) die "--tuning-pack must be true or false" ;; esac

  CONN_JSON=""; CONN_TARGET="$target"
  if [ ${#fields[@]} -gt 0 ]; then
    local IFS=","
    CONN_JSON=",\"connection\": {${fields[*]}}"
  fi
}

# Sets CLIENT_JSON (`,"client_connection": "…"` or empty) from a mode; dies on an invalid one.
build_client_json() {
  CLIENT_JSON=""
  case "$1" in
    none|credentials|full) CLIENT_JSON=",\"client_connection\": \"$1\"" ;;
    "") ;;
    *) die "--client-connection must be none, credentials or full" ;;
  esac
}

cmd_add_token() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh add-token <name> [connection options] (see help)"
  local name="$1"; shift

  parse_conn_opts token "$@"
  build_conn_json
  local conn_json="$CONN_JSON" target="$CONN_TARGET" user="$o_user" client="$o_client"
  build_client_json "$client"
  local client_json="$CLIENT_JSON"

  local raw body
  raw=$(api POST "$API" -d "{\"name\":$(json_str "$name")${conn_json}${client_json}}")
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
  if [ -n "$client" ] && [ "$client" != "none" ]; then
    echo "   Client-supplied connection: ${client} (X-Oracle-* headers)"
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

cmd_set_client_conn() {
  require_token
  case "${2:-}" in
    none|credentials|full) ;;
    *) die "Usage: ./admincli.sh set-client-conn <id> none|credentials|full" ;;
  esac
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh set-client-conn <id> none|credentials|full"
  local id="$1" mode="$2"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d "{\"client_connection\":\"${mode}\"}")
  body=$(check_response "$raw")
  echo "✅ Token ${id}: client-supplied connection = ${mode}."
}

# ── OAuth assignments (group / user → connection) ─────────────────────────────
cmd_whoami() {
  require_token
  local raw body
  raw=$(api GET "${BASE_URL}/admin/me")
  body=$(check_response "$raw")
  if _py3; then
    python3 - "$body" <<'PYEOF'
import sys, json
d = json.loads(sys.argv[1])
print(f"\n  Name    : {d.get('name')}")
print(f"  Method  : {d.get('method')}")
if d.get("email"):
    print(f"  E-mail  : {d['email']}")
o = d.get("oauth")
if o:
    print(f"  OAuth   : issuer {o.get('issuer')}, groups claim '{o.get('groups_claim')}', session {o.get('session_ttl')} s")
else:
    print("  OAuth   : not configured")
print("")
PYEOF
  else
    echo "$body"
  fi
}

cmd_list_assignments() {
  require_token
  local raw body
  raw=$(api GET "$ASSIGN_API")
  body=$(check_response "$raw")
  echo ""
  if _py3; then
    python3 - "$body" <<'PYEOF'
import sys, json
fmt = "{:<8} {:<6} {:<36} {:<6} {:<12} {:<9} {}"
print(fmt.format("ID", "TYPE", "GROUP / USER", "ROLE", "SOURCE", "CLIENT", "CONNECTION"))
print(fmt.format("-" * 8, "-" * 6, "-" * 36, "-" * 6, "-" * 12, "-" * 9, "-" * 30))
for a in json.loads(sys.argv[1]).get("assignments", []):
    kind = "group" if a.get("group") else "user"
    c = a.get("connection") or {}
    target = c.get("tns_alias") or c.get("connect_string") or (c.get("host") and f"{c['host']}/{c.get('service_name') or c.get('sid') or ''}") or "-"
    if c.get("user"):
        target += f" ({c['user']})"
    print(fmt.format(str(a.get("id")), kind, a.get("group") or a.get("user"), "admin" if a.get("admin") else "user",
                     a.get("source", "-"), a.get("client_connection") or "none", target))
PYEOF
  else
    echo "$body"
  fi
  echo ""
}

cmd_show_assignment() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh show-assignment <id>"
  local raw body
  raw=$(api GET "$ASSIGN_API")
  body=$(check_response "$raw")
  if _py3; then
    python3 - "$body" "$1" <<'PYEOF'
import sys, json
a = next((x for x in json.loads(sys.argv[1]).get("assignments", []) if str(x.get("id")) == sys.argv[2]), None)
if not a:
    print(f"❌ Assignment {sys.argv[2]} not found.", file=sys.stderr); sys.exit(1)
print(json.dumps(a, indent=2))
PYEOF
  else
    echo "$body"
  fi
}

cmd_add_assignment() {
  require_token
  parse_conn_opts assignment "$@"
  if [ -n "$o_group" ] && [ -n "$o_email" ]; then die "Use either --group or --email, not both"; fi
  if [ -z "$o_group" ] && [ -z "$o_email" ]; then die "Usage: ./admincli.sh add-assignment --group <group> | --email <e-mail|object id|*@domain> [options] (see help)"; fi
  build_conn_json
  build_client_json "$o_client"

  local subject
  if [ -n "$o_group" ]; then subject="\"group\":$(json_str "$o_group")"; else subject="\"user\":$(json_str "$o_email")"; fi
  local extra=""
  [ -z "$o_admin" ] || extra+=",\"admin\":true"
  [ -z "$o_note" ] || extra+=",\"note\":$(json_str "$o_note")"

  local raw body id
  raw=$(api POST "$ASSIGN_API" -d "{${subject}${extra}${CONN_JSON}${CLIENT_JSON}}")
  body=$(check_response "$raw")
  id=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
  echo ""
  echo "✅ Assignment created (ID: ${id}): ${o_group:+group }${o_group:-user }${o_email}${o_admin:+, admin}"
  [ -z "$CONN_JSON" ] || echo "   Connection: ${CONN_TARGET:-(server default target)} (user: ${o_user:-(default)})"
  [ -z "$o_client" ] || [ "$o_client" = none ] || echo "   Client-supplied connection: ${o_client} (X-Oracle-* headers)"
  echo ""
}

cmd_delete_assignment() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh delete-assignment <id>"
  check_response "$(api DELETE "${ASSIGN_API}/${1}")" >/dev/null
  echo "✅ Assignment ${1} deleted."
}

cmd_set_assignment_conn() {
  require_token
  [ -n "${1:-}" ] && [ -n "${2:-}" ] || die "Usage: ./admincli.sh set-assignment-conn <id> '<json>'"
  local body
  body=$(check_response "$(api PATCH "${ASSIGN_API}/${1}" -d "{\"connection\":${2}}")")
  echo "✅ Assignment ${1} connection updated."
  pretty "$body"
}

cmd_clear_assignment_conn() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh clear-assignment-conn <id>"
  check_response "$(api PATCH "${ASSIGN_API}/${1}" -d '{"connection":null}')" >/dev/null
  echo "✅ Assignment ${1} connection cleared (uses default connection)."
}

cmd_set_assignment_client_conn() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh set-assignment-client-conn <id> none|credentials|full"
  case "${2:-}" in
    none|credentials|full) ;;
    *) die "Usage: ./admincli.sh set-assignment-client-conn <id> none|credentials|full" ;;
  esac
  check_response "$(api PATCH "${ASSIGN_API}/${1}" -d "{\"client_connection\":\"${2}\"}")" >/dev/null
  echo "✅ Assignment ${1}: client-supplied connection = ${2}."
}

cmd_set_assignment_admin() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./admincli.sh set-assignment-admin <id> true|false"
  case "${2:-}" in
    true|false) ;;
    *) die "Usage: ./admincli.sh set-assignment-admin <id> true|false" ;;
  esac
  check_response "$(api PATCH "${ASSIGN_API}/${1}" -d "{\"admin\":${2}}")" >/dev/null
  echo "✅ Assignment ${1}: admin = ${2}."
}

cmd_help() {
  cat <<EOF

oracle-mcp-server admin CLI

  Configuration (env vars or scripts/.env):
    AUTH_TOKEN   Admin token (required for all commands except health); ADMIN_TOKEN is an alias.
                 With OAuth the access token (JWT) of a user whose assignment has admin: true works too.
    MCP_URL      Server URL  (default: http://localhost:3000)

  Server commands (no AUTH_TOKEN needed):
    health                       Show server health status

  Admin commands:
    whoami                       Who the server thinks you are, and whether OAuth is configured

  OAuth assignment commands (OAUTH_ISSUER set; group / e-mail -> default connection):
    list-assignments             Environment (read-only) and stored assignments
    show-assignment <id>         One assignment as JSON (passwords are never shown)
    add-assignment               Create an assignment; the same connection options as add-token plus:
               --group G | --email E     group name/id from the groups claim, or e-mail, object id or *@domain
               [--admin]                 may also use the admin UI and API
               [--note TEXT]
               [--client-connection none|credentials|full]
    delete-assignment <id>       Delete a stored assignment
    set-assignment-conn <id> '<json>'    Replace the connection (omitted password is kept)
    clear-assignment-conn <id>   Back to the server default connection
    set-assignment-client-conn <id> none|credentials|full
    set-assignment-admin <id> true|false

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
               [--client-connection none|credentials|full]
                                      client may send its own user/password (credentials) or
                                      also the target (full) as X-Oracle-* headers (default: none)
    delete-token <id>            Permanently delete a token
    enable-token <id>            Re-enable a token
    disable-token <id>           Temporarily disable a token
    rename-token <id> <name>     Rename a token
    set-conn     <id> '<json>'   Set a custom DB connection for a token (omitted password is kept)
                                 JSON: {"tns_alias":"PROD","user":"u","password":"p"}
    clear-conn   <id>            Clear per-token connection (falls back to default connection)
    set-client-conn <id> none|credentials|full
                                 What the token's clients may set via X-Oracle-* headers

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

    # Clients log in with their own database account (X-Oracle-User / X-Oracle-Password)
    ./admincli.sh add-token "analysts" --client-connection credentials
    ./admincli.sh set-client-conn 2 full

    # OAuth: everybody in the group grp-dba uses the PROD_HIGH alias, alice may bring her own account
    ./admincli.sh add-assignment --group grp-dba --tns-alias PROD_HIGH --user mcp_dba --password secret
    ./admincli.sh add-assignment --email alice@example.com --client-connection credentials
    ./admincli.sh add-assignment --email '*@example.com'          # access with the default connection
    ./admincli.sh add-assignment --group grp-admin --admin        # may use the admin UI/API
    ./admincli.sh list-assignments

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
  set-client-conn) cmd_set_client_conn "${2:-}" "${3:-}" ;;
  whoami)        cmd_whoami ;;
  list-assignments)  cmd_list_assignments ;;
  show-assignment)   cmd_show_assignment   "${2:-}" ;;
  add-assignment)    cmd_add_assignment    "${@:2}" ;;
  delete-assignment) cmd_delete_assignment "${2:-}" ;;
  set-assignment-conn)        cmd_set_assignment_conn        "${2:-}" "${3:-}" ;;
  clear-assignment-conn)      cmd_clear_assignment_conn      "${2:-}" ;;
  set-assignment-client-conn) cmd_set_assignment_client_conn "${2:-}" "${3:-}" ;;
  set-assignment-admin)       cmd_set_assignment_admin       "${2:-}" "${3:-}" ;;
  health)        cmd_health ;;
  help|--help|-h) cmd_help ;;
  *) die "Unknown command: ${1}\nHelp: ./admincli.sh help" ;;
esac
