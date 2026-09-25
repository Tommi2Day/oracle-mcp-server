# ── Build stage: compile TypeScript ───────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Debian (glibc) base so the optional Oracle Instant Client (thick mode) can run.
FROM node:24-slim

# ORACLE_THICK=true installs Oracle Instant Client (basic lite) for thick mode
# (ORA_DRIVER_MODE=thick): needed for sqlnet.ora settings, cwallet.sso auto-login
# wallets, native network encryption and older databases (< 12.1).
ARG ORACLE_THICK=false
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && if [ "$ORACLE_THICK" = "true" ]; then \
      apt-get install -y --no-install-recommends curl unzip \
      && (apt-get install -y --no-install-recommends libaio1 || apt-get install -y --no-install-recommends libaio1t64) \
      && LIBAIO=$(find / -name 'libaio.so.1t64*' 2>/dev/null | head -n1) \
      && if [ -n "$LIBAIO" ]; then ln -sf "$LIBAIO" "$(dirname "$LIBAIO")/libaio.so.1"; fi \
      && case "$TARGETARCH" in arm64) IC=instantclient-basiclite-linux-arm64.zip ;; *) IC=instantclient-basiclite-linuxx64.zip ;; esac \
      && curl -fsSL -o /tmp/ic.zip "https://download.oracle.com/otn_software/linux/instantclient/$IC" \
      && mkdir -p /opt/oracle && unzip -q /tmp/ic.zip -d /opt/oracle && rm /tmp/ic.zip \
      && ln -s /opt/oracle/instantclient_* /opt/oracle/instantclient \
      && echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig \
      && apt-get purge -y curl unzip && apt-get autoremove -y; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /build/dist /app/dist
COPY admin.html docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /certs /data /opt/oracle/network/admin \
 && chown -R node:node /certs /data

ENV TRANSPORT=http \
    PORT=3000 \
    TLS_ENABLED=false \
    TLS_CERT_FILE=/certs/tls.crt \
    TLS_KEY_FILE=/certs/tls.key \
    TOKENS_FILE=/data/tokens.json \
    TNS_ADMIN=/opt/oracle/network/admin \
    ORA_DRIVER_MODE=thin \
    ORA_CLIENT_LIB_DIR=""

USER node

EXPOSE 3000

# Mount point for tnsnames.ora, sqlnet.ora and wallets (volume, ConfigMap or Secret)
VOLUME ["/opt/oracle/network/admin"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "const s=process.env.TLS_ENABLED==='true'?'https':'http';fetch(s+'://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
