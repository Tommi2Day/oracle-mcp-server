#!/bin/bash
# Pulls and starts the oracle-mcp-server Docker container.
# Auto-generates AUTH_TOKEN on first run (saved to ./auth_token).
# Reads defaults.env (optional, site-specific defaults) and then .env from the
# project root if present; .env overrides defaults.env.
# Image: IMAGE (default tommi2day/oracle-mcp-server) and IMAGE_TAG (default latest).
# Tokens and TLS certs persist in the named volumes <name>-data and <name>-certs.
# Oracle client files (tnsnames.ora, sqlnet.ora, ewallet.pem / cwallet.sso) are
# bind-mounted read-only from TNS_ADMIN_DIR (default ./tns_admin) if it exists.
#
# Usage:
#   ./run.sh              # start as "oracle-mcp-server"
#   ./run.sh my-name      # start with a custom container name
NAME=${1:-oracle-mcp-server}
[ -r defaults.env ] && . ./defaults.env
[ -r .env ] && . ./.env
if [ "$(docker ps -a -q -f name=$NAME)" ]; then
  docker stop $NAME
  sleep 10
  docker rm $NAME
fi
if [ ! -r ./auth_token ]; then
  openssl rand -hex 32 > ./auth_token
fi
AUTH_TOKEN=$(cat ./auth_token)
MCP_PORT=${MCP_PORT:-3000}
TLS_ENABLED=${TLS_ENABLED:-false}
IMAGE=${IMAGE:-tommi2day/oracle-mcp-server}
IMAGE_TAG=${IMAGE_TAG:-latest}
TNS_ADMIN_DIR=${TNS_ADMIN_DIR:-./tns_admin}
TNS_MOUNT=()
if [ -d "$TNS_ADMIN_DIR" ]; then
  TNS_MOUNT=(-v "$(cd "$TNS_ADMIN_DIR" && { pwd -W 2>/dev/null || pwd; }):/opt/oracle/network/admin:ro")
fi
docker pull "$IMAGE:$IMAGE_TAG"
docker run -d --name "$NAME" \
  -p "$MCP_PORT:3000" \
  -e TRANSPORT=http \
  -e "AUTH_TOKEN=$AUTH_TOKEN" \
  -e TOKENS_FILE=/data/tokens.json \
  ${ORA_CONNECT_STRING:+-e "ORA_CONNECT_STRING=$ORA_CONNECT_STRING"} \
  ${ORA_TNS_ALIAS:+-e "ORA_TNS_ALIAS=$ORA_TNS_ALIAS"} \
  ${ORA_HOST:+-e "ORA_HOST=$ORA_HOST"} \
  ${ORA_PORT:+-e "ORA_PORT=$ORA_PORT"} \
  ${ORA_SERVICE_NAME:+-e "ORA_SERVICE_NAME=$ORA_SERVICE_NAME"} \
  ${ORA_SID:+-e "ORA_SID=$ORA_SID"} \
  ${ORA_PROTOCOL:+-e "ORA_PROTOCOL=$ORA_PROTOCOL"} \
  -e "ORA_USER=${ORA_USER:-}" \
  -e "ORA_PASSWORD=${ORA_PASSWORD:-}" \
  ${ORA_WALLET_LOCATION:+-e "ORA_WALLET_LOCATION=$ORA_WALLET_LOCATION"} \
  ${ORA_WALLET_PASSWORD:+-e "ORA_WALLET_PASSWORD=$ORA_WALLET_PASSWORD"} \
  ${ORA_SSL_SERVER_DN_MATCH:+-e "ORA_SSL_SERVER_DN_MATCH=$ORA_SSL_SERVER_DN_MATCH"} \
  ${ORA_SSL_SERVER_CERT_DN:+-e "ORA_SSL_SERVER_CERT_DN=$ORA_SSL_SERVER_CERT_DN"} \
  ${ORA_TLS_CA_FILE:+-e "ORA_TLS_CA_FILE=$ORA_TLS_CA_FILE"} \
  ${ORA_DRIVER_MODE:+-e "ORA_DRIVER_MODE=$ORA_DRIVER_MODE"} \
  ${ORA_PERF_TOOLS:+-e "ORA_PERF_TOOLS=$ORA_PERF_TOOLS"} \
  ${ORA_DIAGNOSTICS_PACK:+-e "ORA_DIAGNOSTICS_PACK=$ORA_DIAGNOSTICS_PACK"} \
  ${ORA_TUNING_PACK:+-e "ORA_TUNING_PACK=$ORA_TUNING_PACK"} \
  -e "TLS_ENABLED=$TLS_ENABLED" \
  ${TLS_SAN:+-e "TLS_SAN=$TLS_SAN"} \
  ${LOG_LEVEL:+-e "LOG_LEVEL=$LOG_LEVEL"} \
  ${STORE_ENCRYPTION_KEY:+-e "STORE_ENCRYPTION_KEY=$STORE_ENCRYPTION_KEY"} \
  ${MCP_SERVER_NAME:+-e "MCP_SERVER_NAME=$MCP_SERVER_NAME"} \
  "${TNS_MOUNT[@]}" \
  -v "${NAME}-data:/data" \
  -v "${NAME}-certs:/certs" \
  "$IMAGE:$IMAGE_TAG"

sleep 10
docker logs "$NAME"
