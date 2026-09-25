#!/usr/bin/env bash
# Helm install / upgrade for oracle-mcp-server
# Set the variables in the "Configuration" section or override them via the
# environment / defaults.env (optional, site-specific defaults) / .env.
set -euo pipefail
[ -r defaults.env ] && . ./defaults.env
[ -r .env ] && . ./.env

# ── Configuration ─────────────────────────────────────────────────────────────
RELEASE="${RELEASE:-oracle-mcp}"
NAMESPACE="${NAMESPACE:-mcp}"
CHART="${CHART:-./helm/oracle-mcp-server}"
IMAGE_REPO="${IMAGE_REPO:-tommi2day/oracle-mcp-server}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
# Additional values files, separated by spaces (e.g. "helm/values-prod.yaml")
HELM_VALUES_FILES="${HELM_VALUES_FILES:-}"

# Default connection: either ORA_CONNECT_STRING, ORA_TNS_ALIAS or host/port/service
ORA_CONNECT_STRING="${ORA_CONNECT_STRING:-}"
ORA_TNS_ALIAS="${ORA_TNS_ALIAS:-}"
ORA_HOST="${ORA_HOST:-my-db-host}"
ORA_PORT="${ORA_PORT:-1521}"
ORA_SERVICE_NAME="${ORA_SERVICE_NAME:-FREEPDB1}"
ORA_PROTOCOL="${ORA_PROTOCOL:-tcp}"
ORA_USER="${ORA_USER:-my_user}"
ORA_PASSWORD="${ORA_PASSWORD:-my_password}"

# Existing Secret with tnsnames.ora / sqlnet.ora / ewallet.pem (mounted as TNS_ADMIN).
# Create e.g. with:
#   kubectl -n mcp create secret generic oracle-tns-admin \
#     --from-file=tnsnames.ora --from-file=sqlnet.ora --from-file=ewallet.pem
TNS_ADMIN_SECRET="${TNS_ADMIN_SECRET:-}"

# Generate the admin token if not set
AUTH_TOKEN="${AUTH_TOKEN:-$(openssl rand -hex 32)}"

# ── Helm install / upgrade ────────────────────────────────────────────────────
VALUES_ARGS=()
for f in ${HELM_VALUES_FILES}; do VALUES_ARGS+=(-f "$f"); done
[ -n "$TNS_ADMIN_SECRET" ] && VALUES_ARGS+=(--set tnsAdmin.existingSecret="${TNS_ADMIN_SECRET}")

helm upgrade --install "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" --create-namespace \
  "${VALUES_ARGS[@]}" \
  --set image.repository="${IMAGE_REPO}" \
  --set image.tag="${IMAGE_TAG}" \
  --set-string oracle.connectString="${ORA_CONNECT_STRING}" \
  --set-string oracle.tnsAlias="${ORA_TNS_ALIAS}" \
  --set-string oracle.host="${ORA_HOST}" \
  --set-string oracle.port="${ORA_PORT}" \
  --set-string oracle.serviceName="${ORA_SERVICE_NAME}" \
  --set-string oracle.protocol="${ORA_PROTOCOL}" \
  --set-string oracle.user="${ORA_USER}" \
  --set-string oracle.password="${ORA_PASSWORD}" \
  --set-string auth.token="${AUTH_TOKEN}"

echo ""
echo "✅ ${RELEASE} deployed in namespace '${NAMESPACE}'"
echo ""
echo "   Admin token (keep it safe!):"
echo "   AUTH_TOKEN=${AUTH_TOKEN}"
echo ""
echo "   MCP endpoint:"
echo "   http://$(kubectl get svc -n ${NAMESPACE} ${RELEASE}-oracle-mcp-server -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo '<ClusterIP>'):3000/mcp"
