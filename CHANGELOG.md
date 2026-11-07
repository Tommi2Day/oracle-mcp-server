# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-11-07

First complete version. From here on the MCP tools and their parameters, the admin REST API (`openapi.json`), the
environment variables, the log format and the Helm values follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Compared with 0.3.2 it adds database diagnostics (what is my database doing, locks, alert log, trace files) and ready-made
Claude skills on top of the existing tools.

### Added

- Claude skills in `skills/` (install: copy to `~/.claude/skills`, see `docs/skills.md`): `oracle-db-status` ("what is
  my database doing"), `oracle-top-sessions-sql`, `oracle-problem-detection` (locks, waits, saturation),
  `oracle-sql-tuning`, `oracle-document` (schema documentation, incident / tuning write-ups) and
  `oracle-error-analysis` (alert log, incidents, trace files). Read-only, evidence-based, licence-aware.
- Tools for the skills (unlicensed, `ORA_PERF_TOOLS`): `db_overview` (instance, load, sessions, CPU vs. wait classes,
  attention points), `locks` (blocked sessions, root blockers, held locks; prints but never runs `KILL SESSION`),
  `alert_log` (`V$DIAG_ALERT_EXT`), `incidents` (`V$DIAG_INCIDENT` / `V$DIAG_PROBLEM`), `trace_files` and
  `trace_content` (`V$DIAG_TRACE_FILE[_CONTENTS]`; head/tail, text filter with `grep -C`-style `context`, output capped, name
  validated). `locks` also shows the module of the root blockers.
- `grant_perf_privileges.sql` takes a fifth parameter `logs` (`MCP_PERF_LOG_ROLE`: alert log, incidents, trace files)
  and grants the views of `db_overview` / `locks` (`V$INSTANCE`, `V$SYSMETRIC`, `V$CON_SYSMETRIC`, `V$OSSTAT`,
  `V$LOCKED_OBJECT`) to `MCP_PERF_ROLE`; `revoke_perf_privileges.sql` removes the log role. `SELECT_CATALOG_ROLE` does
  not include `V$DIAG_ALERT_EXT` / `V$DIAG_INCIDENT`, so `logs = Y` is also needed in `CATALOG` mode.

## [0.3.2] - 2026-11-07

### Added

- The Helm chart is published to GitHub Container Registry on every release and can be installed with
  `helm install oracle-mcp oci://ghcr.io/tommi2day/charts/oracle-mcp-server --version <version>`. New workflow
  `helm-chart.yml` (called by the release workflow, also runnable manually for an existing tag).

### Security

- All HTTP responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store` (admin UI clickjacking protection; token and
  connection data are not cached by browsers or proxies).
- Updated dependencies (`vitest` / `@vitest/coverage-v8` 5.1, `npm audit fix` for zod, vite and source-map-js);
  `npm audit` reports 0 vulnerabilities.
- `package.json` overrides `minimatch` to `^11.0.5` (GHSA-g3hv-75wg-m249, pulled in by eslint; dev only).
- Docker image no longer ships npm/npx/corepack (unused at runtime, carried CVEs in bundled packages); production
  dependencies are installed in a separate build stage.
- Docker image is based on `node:24-trixie-slim` (Node.js 24 LTS) instead of `node:25-trixie-slim`; Node 25 is not
  an LTS release and no longer receives updates. Matches the Node version used in CI and `scripts/`.

### Changed

- Updated the Oracle driver `oracledb` to 26.0.0 (`@types/oracledb` 26.0.1, `globals` 17.14); verified against Oracle
  Free 23ai in thin mode (all tools, session tags). Node.js 14.17+ is still sufficient for the driver.
- Helm: `image.tag` defaults to the chart `appVersion` instead of `latest`, so a chart version deploys its matching
  image. Set `image.tag` explicitly for the `-thick` variant or to keep following `latest`.
  `scripts/helm_install.sh` only passes `image.tag` when `IMAGE_TAG` is set.
- `@types/node` is pinned to the Node.js 24 line (`^24`) to match the runtime; Dependabot no longer proposes major
  updates of the `node` Docker image or `@types/node`.
- Release workflow: the GitHub release notes start with the matching `CHANGELOG.md` section, followed by the
  generated notes.

## [0.3.1] - 2026-09-28

### Changed

- Docker image based on Debian 13 (`node:25-trixie-slim`) instead of Debian 12: critical CVEs of the base image
  (GnuTLS, Perl) are only fixed in trixie; `apt-get upgrade` adds the security updates released after the base
  image. Thin and thick mode (Instant Client with `libaio1t64`) unchanged
- Internal refactoring to keep the cognitive complexity of every function below 15 (Sonar rule S3776): the HTTP
  router, MCP session start/resume, the admin token API, connect string parsing/merging, `awr_top_events`, startup
  and the admin UI form builder are split into small functions; the `query` result formatting moved out of the
  tool handler (S2004) and a regex got explicit groups (S5850). No change in behavior, API or log output
- `npm run ci:test` also writes `coverage/lcov.info` (coverage of `src/`), so SonarQube picks up the test coverage
  instead of reporting 0%

### Fixed

- Admin UI keyboard accessibility (Sonar S1082): Escape closes dialogs via a key handler on the dialog backdrop (the
  dialog gets the focus when it has no input field, e.g. the delete confirmation); "Use default connection" is a
  focusable button that toggles with Enter/Space
- `npm version` updates `openapi.json` and the Helm chart version again (the lifecycle script had an unescaped
  newline)

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
