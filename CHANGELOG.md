# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Internal refactoring to keep the cognitive complexity of every function below 15 (Sonar rule S3776): the HTTP
  router, MCP session start/resume, the admin token API, connect string parsing/merging, `awr_top_events`, startup
  and the admin UI form builder are split into small functions. No change in behavior, API or log output
- `npm run ci:test` also writes `coverage/lcov.info` (coverage of `src/`), so SonarQube picks up the test coverage
  instead of reporting 0%

## [0.3.0] - 2026-09-27

### Added

- Client-supplied connections: a token's `client_connection` (`none` default, `credentials`, `full`) lets its MCP
  clients send their own database user/password — and with `full` the target — as `X-Oracle-*` headers on the
  `initialize` request. A client target requires client credentials; wallets/`TNS_ADMIN` cannot be referenced;
  the permission is re-checked on every request; such sessions get their own pool, closed with the last session.
  `ORA_CLIENT_CONNECTION` for the admin token; admin UI, REST API (`openapi.json`), `admincli.sh`
  (`--client-connection`, `set-client-conn`), Helm `oracle.clientConnection`.
- Admin UI branding: `ADMIN_LOGO` (logo file or URL) replaces the icon, `ADMIN_THEME_CSS` loads a stylesheet that
  overrides the color/font variables; all colors of `admin.html` are now CSS variables. Example theme in
  `examples/admin-theme/`, screenshots in the README; Helm values `adminUi.brandingConfigMap` / `themeCss` / `logo`.

## [0.2.1] - 2026-09-26

### Changed

- Described as an MCP server "for AI tools" instead of "for Claude" (`package.json`, Helm chart, README).
- README: feature overview and a "When to choose this server" section comparing it with local Oracle MCP servers
  (SQLcl), the Autonomous AI Database MCP Server and DBHub; `DOCKERHUB.md` gets a short version.

## [0.2.0] - 2026-09-26

### Added

- README: screenshots of the admin UI and of the log output (`docs/images/`); `DOCKERHUB.md` shows the token list
  and the log output.

### Fixed

- Admin UI: password field placeholders (e.g. *Wallet password*) use the normal font instead of the spaced
  monospace font of the entered value; shorter *Diagnostics Pack* label keeps the form rows aligned.

## [0.1.0] - 2026-09-26

### Added

- Initial Oracle Database MCP server, ported from pg-mcp-server to TypeScript and node-oracledb 7.
- Connection methods: host/port/service name or SID, TNS alias (`tnsnames.ora`), free connect strings
  (Easy Connect Plus, descriptors) and JDBC URLs (incl. `host:port:SID`, embedded credentials, `?TNS_ADMIN=`).
- TCP and TCPS: wallets (`ewallet.pem`), certificate-only PEM files as trusted CAs, `ORA_TLS_CA_FILE`,
  server DN matching and certificate DN pinning.
- Thin mode (default) and thick mode (Instant Client image variant via `--build-arg ORACLE_THICK=true`).
- `TNS_ADMIN` volume at `/opt/oracle/network/admin`; Helm chart mounts Secrets/ConfigMaps/inline files as a
  projected volume, plus extra wallet directories for per-token connections.
- Tools: `query`, `execute` (with `DBMS_OUTPUT`), `list_tables`, `describe_table`, `list_schemas`, `test_connection`.
- `/info` endpoint describing the default connection without secrets.
- Performance analysis tools: `explain_plan`, `sql_plan`, `top_sql`, `session_activity`, `table_stats`;
  Diagnostics Pack tools `ash_top`, `awr_top_events` and Tuning Pack tool `sql_monitor`.
- Licence switches `ORA_PERF_TOOLS`, `ORA_DIAGNOSTICS_PACK`, `ORA_TUNING_PACK` (packs off by default) with
  per-token overrides `diagnostics_pack` / `tuning_pack`; disabled tools are not listed and refuse to run.
- Session identification: `PROGRAM` and `MODULE` = `MCP_SERVER_NAME`, `ACTION` = tool name
  (`mcp-perf:<tool>` for performance tools), `CLIENT_IDENTIFIER` = token name, `CLIENT_INFO` = server, version
  and client IP.
- `scripts/sql/grant_perf_privileges.sql` / `revoke_perf_privileges.sql`: grant the performance tool privileges via
  separate roles `MCP_PERF_ROLE`, `MCP_PERF_DIAG_ROLE`, `MCP_PERF_TUNING_ROLE` (or `SELECT_CATALOG_ROLE`).
- `docs/performance.md`: tools, licensing switches, required privileges, workflows and troubleshooting.
- MIT license.

### Changed (compared to pg-mcp-server)

- Token connection secrets (`password`, `wallet_password`) are write-only in the admin API
  (`password_set` flag) and kept on `PATCH` when omitted; both are encrypted at rest with `STORE_ENCRYPTION_KEY`.
- Tokens with identical effective connections share one pool.
- Runtime image is `node:25-slim` (glibc) instead of Alpine to allow the Oracle Instant Client.
