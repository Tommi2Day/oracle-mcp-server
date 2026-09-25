# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Oracle port of [tommi2day/pg-mcp-server](https://github.com/tommi2day/pg-mcp-server): same auth, token store,
admin UI/API, logging and deployment model, but TypeScript and node-oracledb.

## Commands

```bash
npm run build            # tsc -p tsconfig.build.json → dist/
npm test                 # vitest (unit tests, mocked driver — no database needed)
npm run lint             # eslint (typescript-eslint)
npm run typecheck        # tsc --noEmit incl. tests
./scripts/test.sh        # tests in Docker (no local Node.js)
docker compose up -d     # Oracle Free test DB + server (examples/tns_admin mounted as TNS_ADMIN)
docker build --build-arg ORACLE_THICK=true -t oracle-mcp-server:thick .   # Instant Client variant
./scripts/admincli.sh …  # token management (add-token supports --tns-alias/--connect-string/--host …)
```

## Architecture

- **`src/oracle.ts`** — pure connection logic, no driver import: `parseConnectString` (JDBC URLs, `host:port:SID`,
  `?TNS_ADMIN=`), `buildHostConnectString`, `connectionFromEnv` (ORA_* vars), `mergeConnection` (token + default),
  `resolvePoolAttributes` (→ oracledb pool attrs), `inspectWallet` / `trustedCaFile` (ewallet.pem with key → wallet,
  certificate-only → trusted CA), `describeConnection` (password-free, for /info), `normalizeSql`.
- **`src/lib.ts`** — logging, auth, token store (AES-256-GCM for `password` and `wallet_password`), admin API,
  `validateConnection`, `toSafeToken` (secrets never returned; `password_set` flags).
- **`src/index.ts`** — MCP tools, pool cache, HTTP routing, startup. `isMain` guard keeps imports side-effect free.
- **`src/perf.ts`** — performance tools (`PERF_TOOLS` with a `feature` each: `perf`, `diagnostics`, `tuning`).
  `perfToolList(features)` filters ListTools, `runPerfTool` re-checks the feature (`assertPerfToolEnabled`), sets
  `MODULE=oracle-mcp-server-perf` (excluded in `top_sql`) and adds a privilege hint to ORA-00942/01031.
  Features come from `perfFeatures(mergedConnection)` (`oracle.ts`): `ORA_PERF_TOOLS` global, packs from
  `diagnostics_pack` / `tuning_pack` (token) falling back to `ORA_DIAGNOSTICS_PACK` / `ORA_TUNING_PACK`; default off.
  Timestamps in ASH/AWR are server-local `TIMESTAMP`s — compare with `CAST(SYSTIMESTAMP AS TIMESTAMP)`, never
  `SYSTIMESTAMP` (session time zone shifts the window). AWR deltas use LEFT JOIN on the begin snapshot.
- **`src/format.ts`** — `formatCell`, `formatTable` (aligned text tables).
- **`scripts/sql/grant_perf_privileges.sql`** — grants for the perf tools; keep its object lists and the privilege
  table in `docs/performance.md` in sync with the views queried in `src/perf.ts`.
- **`admin.html`** — single-file admin SPA (from pg-mcp-server, connection form adapted to Oracle fields).

### Connection precedence and merging

Target precedence: `connect_string` > `tns_alias` > `host`. `mergeConnection`: a token that sets any target
field takes the whole target from the token (never mixes with default host fields); `user/password` fall back
to the default only if the token sets no user; `tns_admin`/wallet/TLS fields fall back individually.

### Pools

`getPool(connection)` returns a promise of an `oracledb.Pool`, cached by SHA-256 of `{attrs, caFile}` —
tokens with identical effective connections share a pool. Failed pool creation is evicted from the cache.
`releasePool` closes a pool on token delete/update only if no other active token maps to it.
MCP sessions get a pool *provider* (`() => getPool(conn)`), so connection errors surface as tool errors.

### TCPS / wallets (thin mode)

node-oracledb thin passes `ewallet.pem` as cert+key+CA to `tls.createSecureContext`, so a certificate-only
PEM fails (NJS-505). Therefore certificate-only wallets (and `ORA_TLS_CA_FILE`) are added to the process
default CA set via `tls.setDefaultCACertificates` (`registerTrustedCa`), and only key-bearing wallets are
passed as `walletLocation`. Thick mode ignores per-connection network attrs; everything comes from `TNS_ADMIN`.

### Tools

`query` only accepts SELECT/WITH (DDL would implicitly commit), runs in `SET TRANSACTION READ ONLY`,
retries without the snapshot on ORA-01466 (freshly created objects), always rolls back.
`execute` uses `autoCommit`, returns `DBMS_OUTPUT` for PL/SQL. DATE/TIMESTAMP are formatted from local
components (driver maps them to local time), TZ types as ISO UTC.

### Logging

Same line format as pg-mcp-server (`[ts] [LEVEL] [CATEGORY] …`), documented in `docs/logging.md`.
SQL text only at `LOG_LEVEL=debug`.

## Tests

- `tests/oracle.test.ts` — connect string parsing, merging, pool attributes, wallets
- `tests/lib.test.ts`, `tests/admin.test.ts` — auth, store encryption, admin API (mock `node:fs`)
- `tests/index.test.ts` — tools/routing with mocked `oracledb`, MCP SDK and `lib.js`

## Version sync

`package.json`, `openapi.json` (`info.version`) and `helm/oracle-mcp-server/Chart.yaml` (`version`, `appVersion`)
are kept in sync by the `version` npm lifecycle script / release workflow. User-facing changes go to
`CHANGELOG.md` under `[Unreleased]`; keep `DOCKERHUB.md` in sync with the README.
