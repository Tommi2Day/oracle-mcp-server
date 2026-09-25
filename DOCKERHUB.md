# oracle-mcp-server

Multi-user [Model Context Protocol](https://modelcontextprotocol.io) server for **Oracle Database**:
token auth, per-token database connections, admin UI, audit logging, TLS.
Source & full documentation: https://github.com/tommi2day/oracle-mcp-server

## Tags

- `latest`, `<version>` — thin mode (pure JavaScript driver, no Oracle Client)
- `latest-thick`, `<version>-thick` — with Oracle Instant Client for thick mode (`ORA_DRIVER_MODE=thick`)

## Connection methods

- host / port / service name or SID (`ORA_HOST`, `ORA_PORT`, `ORA_SERVICE_NAME`/`ORA_SID`)
- TNS alias from `tnsnames.ora` (`ORA_TNS_ALIAS`)
- free connect string: Easy Connect Plus, connect descriptor or **JDBC URL** (`ORA_CONNECT_STRING`)
- SQL*Net **TCP** or **TCPS** (`ORA_PROTOCOL=tcps`, wallets, server DN matching, private CAs)

## Quick start

```bash
docker run -d -p 3000:3000 \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -e ORA_CONNECT_STRING='jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1' \
  -e ORA_USER=app -e ORA_PASSWORD=secret \
  -v "$PWD/tns_admin:/opt/oracle/network/admin:ro" \
  -v oracle-mcp-data:/data \
  tommi2day/oracle-mcp-server
```

`/opt/oracle/network/admin` (= `TNS_ADMIN`) takes `tnsnames.ora`, `sqlnet.ora` (thick mode),
`ewallet.pem` (thin mode wallet or trusted CA certificates) and `cwallet.sso` (thick mode).
In Kubernetes mount them from a Secret/ConfigMap (Helm chart: `tnsAdmin.existingSecret`).

## Endpoints

| Path | Description |
|------|-------------|
| `/mcp` | MCP Streamable HTTP (Bearer token) |
| `/admin` | Admin UI for tokens and per-token connections |
| `/admin/tokens` | Token REST API (admin token) |
| `/info` | Server info and default connection (admin token) |
| `/health` | Health check |

## Tools

`query` (read-only SELECT), `execute` (DML/DDL/PL/SQL with DBMS_OUTPUT), `list_tables`, `describe_table`,
`list_schemas`, `test_connection`.

Performance analysis: `explain_plan`, `sql_plan`, `top_sql`, `session_activity`, `table_stats`; with
`ORA_DIAGNOSTICS_PACK=true` also `ash_top`, `awr_top_events`, with `ORA_TUNING_PACK=true` `sql_monitor`.
Licensed tools are **off by default** and can be switched per token.

## Main environment variables

`AUTH_TOKEN`, `STORE_ENCRYPTION_KEY`, `ORA_CONNECT_STRING`, `ORA_TNS_ALIAS`, `ORA_HOST`, `ORA_PORT`,
`ORA_SERVICE_NAME`, `ORA_SID`, `ORA_PROTOCOL`, `ORA_USER`, `ORA_PASSWORD`, `ORA_WALLET_LOCATION`,
`ORA_WALLET_PASSWORD`, `ORA_SSL_SERVER_DN_MATCH`, `ORA_SSL_SERVER_CERT_DN`, `ORA_TLS_CA_FILE`,
`ORA_DRIVER_MODE`, `ORA_PERF_TOOLS`, `ORA_DIAGNOSTICS_PACK`, `ORA_TUNING_PACK`, `TLS_ENABLED`, `LOG_LEVEL` — see the GitHub README for the full reference.

## License

MIT — see https://github.com/Tommi2Day/oracle-mcp-server/blob/main/LICENSE
