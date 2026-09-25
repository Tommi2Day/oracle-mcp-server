# Performance analysis

oracle-mcp-server includes tools for SQL tuning and performance diagnosis. Tools that use data of an Oracle
management pack (Diagnostics Pack, Tuning Pack) are **disabled by default** and must be enabled explicitly
for databases that are licensed for the pack.

- [Tools and licences](#tools-and-licences)
- [Enabling and disabling](#enabling-and-disabling)
- [Required database privileges](#required-database-privileges)
- [Roles vs. direct grants](#roles-vs-direct-grants)
- [Grant script](#grant-script)
- [Tool reference](#tool-reference)
- [Typical workflows](#typical-workflows)
- [Database settings that matter](#database-settings-that-matter)
- [Troubleshooting](#troubleshooting)

---

## Tools and licences

| Tool | Purpose | Oracle licence | Server switch |
|------|---------|----------------|---------------|
| `explain_plan` | Optimizer plan of a statement without executing it | – | `ORA_PERF_TOOLS` |
| `sql_plan` | Actual plan of a cached cursor (`DBMS_XPLAN.DISPLAY_CURSOR`) | – | `ORA_PERF_TOOLS` |
| `top_sql` | Most expensive statements in the shared pool | – | `ORA_PERF_TOOLS` |
| `session_activity` | Current sessions, waits, blockers, top wait events | – | `ORA_PERF_TOOLS` |
| `table_stats` | Optimizer statistics of a table, its indexes and columns | – | `ORA_PERF_TOOLS` |
| `ash_top` | Active Session History (`V$ACTIVE_SESSION_HISTORY`) | **Diagnostics Pack** | `ORA_DIAGNOSTICS_PACK` |
| `awr_top_events` | DB time / DB CPU / wait events between AWR snapshots (`DBA_HIST_*`) | **Diagnostics Pack** | `ORA_DIAGNOSTICS_PACK` |
| `sql_monitor` | Real-Time SQL Monitoring (`V$SQL_MONITOR`, `DBMS_SQLTUNE.REPORT_SQL_MONITOR`) | **Tuning Pack** | `ORA_TUNING_PACK` |

Oracle licenses the Tuning Pack only together with the Diagnostics Pack; the server logs a warning if
`ORA_TUNING_PACK` is enabled without `ORA_DIAGNOSTICS_PACK`. Check your licence agreement and the
*Oracle Database Licensing Information User Manual* of your release — this documentation is not licensing advice.

---

## Enabling and disabling

| Setting | Default | Effect |
|---------|---------|--------|
| `ORA_PERF_TOOLS` | `true` | `false` hides **all** performance tools (global kill switch) |
| `ORA_DIAGNOSTICS_PACK` | `false` | `true` enables `ash_top`, `awr_top_events` for the default connection |
| `ORA_TUNING_PACK` | `false` | `true` enables `sql_monitor` for the default connection |

Per token (one server, several databases with different licences) the connection fields
`diagnostics_pack` / `tuning_pack` override the server defaults:

```bash
# admin CLI
./scripts/admincli.sh add-token prod-dba --tns-alias PROD --user perf_mon --password '…' \
    --diagnostics-pack true --tuning-pack true
./scripts/admincli.sh set-conn 3 '{"tns_alias":"TEST","user":"perf_mon","diagnostics_pack":false}'

# REST API
curl -X POST -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:3000/admin/tokens \
  -d '{"name":"prod-dba","connection":{"tns_alias":"PROD","diagnostics_pack":true}}'
```

In the admin UI the token dialog has *Diagnostics Pack* / *Tuning Pack* selectors
(*Server default* / *Licensed* / *Not licensed*). Helm: `oracle.perfTools`, `oracle.diagnosticsPack`,
`oracle.tuningPack`. The startup banner and `GET /info` (`features`) show the active state.

Disabled tools are **not listed** to MCP clients, and a direct call is rejected before any SQL is executed.

> **Scope of the switches.** They control this server's dedicated tools only. The generic `query` tool can
> read any view the database user may access. To prevent pack usage technically, do not give the database
> user access to the licensed views — the [grant script](#grant-script) in `MINIMAL` mode only grants them
> when a pack is requested.

---

## Required database privileges

| Tool | Objects read | Privileges needed |
|------|--------------|-------------------|
| `explain_plan` | `PLAN_TABLE`, `DBMS_XPLAN` (both public) | none, plus access to the tables in the statement |
| `table_stats` | `ALL_TABLES`, `ALL_TAB_STATISTICS`, `ALL_INDEXES`, `ALL_IND_COLUMNS`, `ALL_TAB_COLUMNS` | none — shows tables the user has privileges on |
| `sql_plan` | `V$SQL`, `V$SQL_PLAN`, `V$SQL_PLAN_STATISTICS_ALL`, `V$SESSION` | `SELECT` on these views |
| `top_sql` | `V$SQLAREA` | `SELECT` |
| `session_activity` | `V$SESSION`, `V$SYSTEM_EVENT` | `SELECT` |
| `ash_top` | `V$ACTIVE_SESSION_HISTORY`, `ALL_USERS` | `SELECT` on `V$ACTIVE_SESSION_HISTORY` |
| `awr_top_events` | `DBA_HIST_SNAPSHOT`, `DBA_HIST_SYS_TIME_MODEL`, `DBA_HIST_SYSTEM_EVENT` (in a PDB also `AWR_ROOT_*`) | `SELECT` |
| `sql_monitor` | `V$SQL_MONITOR`, `V$SQL_PLAN_MONITOR`, `DBMS_SQLTUNE` | `SELECT`, `EXECUTE ON DBMS_SQLTUNE` |
| hints for all licensed tools | `V$PARAMETER` (`CONTROL_MANAGEMENT_PACK_ACCESS`) | `SELECT` (optional) |

Notes:

- V$ views are public synonyms for `SYS.V_$…` views — grants go on `SYS.V_$SQLAREA` etc.
- `DBMS_SQLTUNE` is invoker-rights and usually executable by `PUBLIC`; without `SELECT` on
  `V$SQL_MONITOR` / `V$SQL_PLAN_MONITOR` the report contains only its title. `sql_monitor` detects that.
- Privileges may come from roles — see [Roles vs. direct grants](#roles-vs-direct-grants).
- Roles and grants take effect for **new sessions** — restart the MCP server (its connection pool) after
  changing privileges.
- Missing privileges produce an error with a hint pointing to this page.

### Roles vs. direct grants

All privileges can be granted **through roles**; direct grants to the user are not required. The grant script
relies on this, and it was verified: the test users had no direct grants on any `V$` / `DBA_HIST` view, received
everything via `MCP_PERF_*` roles or `SELECT_CATALOG_ROLE`, and all tools worked.

Why roles are sufficient: Oracle disables roles only inside **definer-rights** PL/SQL (stored procedures,
functions, packages, and views owned by a user). The server never runs such code:

| Tool call | Executed as | Roles effective |
|-----------|-------------|-----------------|
| `top_sql`, `session_activity`, `table_stats`, `ash_top`, `awr_top_events`, `sql_monitor` (list) | plain SQL | yes |
| `explain_plan` | `EXECUTE IMMEDIATE` in an anonymous PL/SQL block | yes (anonymous blocks keep roles) |
| `sql_plan` | `DBMS_XPLAN.DISPLAY_CURSOR` — invoker rights | yes |
| `sql_monitor` (report) | `DBMS_SQLTUNE.REPORT_SQL_MONITOR` — invoker rights (`AUTHID CURRENT_USER`) | yes |

Caveats — cases where a role does **not** help:

1. **The role must be a default role.** The server never issues `SET ROLE`; only roles enabled at login count.
   Newly granted roles are default roles unless the user was configured with `ALTER USER … DEFAULT ROLE <list>`
   or `DEFAULT ROLE NONE`. The grant script warns in that case. Check and fix:

   ```sql
   SELECT granted_role, default_role FROM dba_role_privs WHERE grantee = 'MCP';
   ALTER USER mcp DEFAULT ROLE ALL;     -- or add the MCP_PERF_* roles to the existing list
   ```

2. **No password-protected or secure application roles.** Roles created `IDENTIFIED BY …` or
   `IDENTIFIED USING <package>` are not enabled at login and cannot be used. The script creates plain roles.
3. **Only new sessions see changes.** Pooled connections keep the roles they were opened with — restart the
   server after granting or revoking.
4. **Own definer-rights code needs direct grants.** If you wrap these views in your own stored procedure,
   function or view (owned by a user and then called through the `execute` or `query` tool), roles are ignored
   inside that object. Grant the views directly to the owner (see [Manual grants](#manual-grants)) — and
   `WITH GRANT OPTION` if the object is a view used by other users — or declare the PL/SQL `AUTHID CURRENT_USER`.
   The built-in tools never need this.
5. **Multitenant: roles are container-local.** The script creates local roles in the PDB where it runs. For a
   common user (`C##…`) used in several PDBs, run the script in each PDB, or create common roles yourself
   (`CREATE ROLE c##mcp_perf_role CONTAINER=ALL` in the root, grants with `CONTAINER=ALL`).

---

## Grant script

`scripts/sql/grant_perf_privileges.sql` grants exactly what the tools need. Run it in SQL*Plus or SQLcl as
SYS (or another user allowed to grant on SYS objects), **in the container where the MCP user lives**:

```sql
sqlplus / as sysdba
SQL> ALTER SESSION SET CONTAINER = FREEPDB1;                -- multitenant: switch to the PDB
SQL> @scripts/sql/grant_perf_privileges.sql MCP             -- unlicensed tools only
SQL> @scripts/sql/grant_perf_privileges.sql MCP MINIMAL Y Y -- + Diagnostics and Tuning Pack
SQL> @scripts/sql/grant_perf_privileges.sql MCP MINIMAL Y N -- + Diagnostics Pack only
SQL> @scripts/sql/grant_perf_privileges.sql MCP CATALOG     -- SELECT_CATALOG_ROLE instead
```

Parameters: `<user> [mode] [diagnostics Y|N] [tuning Y|N]`.

### MINIMAL mode (default, recommended)

Creates up to three roles and grants the ones requested to the user:

| Role | Created / granted | Contents |
|------|-------------------|----------|
| `MCP_PERF_ROLE` | always | `SELECT` on `V_$SQL`, `V_$SQL_PLAN`, `V_$SQL_PLAN_STATISTICS_ALL`, `V_$SESSION`, `V_$SQLAREA`, `V_$SYSTEM_EVENT` |
| `MCP_PERF_DIAG_ROLE` | with `diagnostics = Y` | `SELECT` on `V_$ACTIVE_SESSION_HISTORY`, `DBA_HIST_SNAPSHOT`, `DBA_HIST_SYS_TIME_MODEL`, `DBA_HIST_SYSTEM_EVENT`, `AWR_ROOT_SNAPSHOT`, `AWR_ROOT_SYS_TIME_MODEL`, `AWR_ROOT_SYSTEM_EVENT`, `V_$PARAMETER` |
| `MCP_PERF_TUNING_ROLE` | with `tuning = Y` | `SELECT` on `V_$SQL_MONITOR`, `V_$SQL_PLAN_MONITOR`, `V_$PARAMETER`; `EXECUTE` on `DBMS_SQLTUNE` |

The script **sets the desired state**: running it with `diagnostics = N` (or `tuning = N`) revokes a
previously granted pack role from that user. The pack roles are separate, so a licensed user never widens
the access of an unlicensed one. Objects that do not exist in older releases (`AWR_ROOT_*` before 12.2) are
reported as `SKIP`; the script is safe to run repeatedly.

Example output:

```text
oracle-mcp-server performance privileges for MCP – mode MINIMAL, Diagnostics Pack Y, Tuning Pack N

OK    CREATE ROLE MCP_PERF_ROLE
OK    GRANT SELECT ON SYS.V_$SQL TO MCP_PERF_ROLE
…
OK    GRANT MCP_PERF_ROLE TO "MCP"
OK    CREATE ROLE MCP_PERF_DIAG_ROLE
OK    GRANT SELECT ON SYS.V_$ACTIVE_SESSION_HISTORY TO MCP_PERF_DIAG_ROLE
…
OK    GRANT MCP_PERF_DIAG_ROLE TO "MCP"

Done. Reconnect (restart the MCP server) so new sessions pick up the privileges.
Enable the licensed tools in the server: ORA_DIAGNOSTICS_PACK / ORA_TUNING_PACK = true
```

### CATALOG mode

Grants `SELECT_CATALOG_ROLE` (and `EXECUTE ON DBMS_SQLTUNE` with `tuning = Y`). Simpler, but the role
gives read access to the whole data dictionary **including the pack-licensed views**; pack usage is then
only prevented by the server switches.

### Revoking

```sql
SQL> @scripts/sql/revoke_perf_privileges.sql MCP        -- revoke the roles / SELECT_CATALOG_ROLE from MCP
SQL> @scripts/sql/revoke_perf_privileges.sql MCP Y      -- … and drop the MCP_PERF_* roles
```

### Manual grants

Equivalent statements if you prefer to grant directly (run as SYS in the user's container):

```sql
-- unlicensed tools
GRANT SELECT ON SYS.V_$SQL                    TO mcp;
GRANT SELECT ON SYS.V_$SQL_PLAN               TO mcp;
GRANT SELECT ON SYS.V_$SQL_PLAN_STATISTICS_ALL TO mcp;
GRANT SELECT ON SYS.V_$SESSION                TO mcp;
GRANT SELECT ON SYS.V_$SQLAREA                TO mcp;
GRANT SELECT ON SYS.V_$SYSTEM_EVENT           TO mcp;
-- Diagnostics Pack (only when licensed)
GRANT SELECT ON SYS.V_$ACTIVE_SESSION_HISTORY TO mcp;
GRANT SELECT ON SYS.DBA_HIST_SNAPSHOT         TO mcp;
GRANT SELECT ON SYS.DBA_HIST_SYS_TIME_MODEL   TO mcp;
GRANT SELECT ON SYS.DBA_HIST_SYSTEM_EVENT     TO mcp;
GRANT SELECT ON SYS.AWR_ROOT_SNAPSHOT         TO mcp;   -- 12.2+, PDB only
GRANT SELECT ON SYS.AWR_ROOT_SYS_TIME_MODEL   TO mcp;   -- 12.2+, PDB only
GRANT SELECT ON SYS.AWR_ROOT_SYSTEM_EVENT     TO mcp;   -- 12.2+, PDB only
-- Tuning Pack (only when licensed)
GRANT SELECT ON SYS.V_$SQL_MONITOR            TO mcp;
GRANT SELECT ON SYS.V_$SQL_PLAN_MONITOR       TO mcp;
GRANT EXECUTE ON SYS.DBMS_SQLTUNE             TO mcp;
-- optional: "pack disabled in the database" hint
GRANT SELECT ON SYS.V_$PARAMETER              TO mcp;
```

The privilege matrix was verified with every tool on Oracle Database 23ai Free (in a PDB) for users with
no grants, `MINIMAL` without packs, `MINIMAL` with the Tuning Pack only, `MINIMAL` with both packs, and `CATALOG`.

---

## Tool reference

All tools return plain text. Tables are column-aligned; numbers are right-aligned.

### explain_plan

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sql` | required | SELECT, WITH, INSERT, UPDATE, DELETE or MERGE; bind variables (`:1`, `:name`) may stay unbound |
| `format` | `TYPICAL` | `DBMS_XPLAN` format, e.g. `BASIC`, `ALL`, `ADVANCED`, `TYPICAL +OUTLINE` |

Runs `EXPLAIN PLAN SET STATEMENT_ID = … FOR <sql>` and `DBMS_XPLAN.DISPLAY` on one connection and rolls back.
The statement is **not executed**. Bind variables are treated as `VARCHAR2`, so implicit conversions show up
(`filter("DEPT"=TO_NUMBER(:D))`) and the plan can differ from the one used with typed binds — use `sql_plan`
for the real plan.

```text
Plan hash value: 2137062967
---------------------------------------------------------------------------------------------------
| Id  | Operation                           | Name        | Rows  | Bytes | Cost (%CPU)| Time     |
---------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT                    |             |     2 |    38 |     3   (0)| 00:00:01 |
|*  1 |  TABLE ACCESS BY INDEX ROWID BATCHED| PERF_EMP    |     2 |    38 |     3   (0)| 00:00:01 |
|*  2 |   INDEX RANGE SCAN                  | PERF_EMP_PK |    99 |       |     2   (0)| 00:00:01 |
---------------------------------------------------------------------------------------------------
Predicate Information (identified by operation id):
   1 - filter("E"."DEPT"=TO_NUMBER(:D))
   2 - access("E"."ID"<100)
```

### sql_plan

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sql_id` | required | 13-character SQL_ID (from `top_sql`, `session_activity`, `ash_top`) |
| `child_number` | all children | child cursor |
| `format` | `TYPICAL +PEEKED_BINDS` | e.g. `ALLSTATS LAST` for actual rows/buffers/time per plan line |

`ALLSTATS LAST` needs row source statistics: run the statement with the `/*+ GATHER_PLAN_STATISTICS */` hint
or `STATISTICS_LEVEL = ALL` (session level). Otherwise the plan shows `E-Rows` only plus a note.
The cursor must still be in the shared pool.

### top_sql

| Parameter | Default | Description |
|-----------|---------|-------------|
| `order_by` | `elapsed` | `elapsed`, `cpu`, `buffer_gets`, `disk_reads`, `executions`, `elapsed_per_exec` |
| `schema` | – | only statements parsed by this schema |
| `sql_text_like` | – | case-insensitive text filter |
| `include_system` | `false` | include statements parsed as SYS |
| `limit` | 10 | max. 100 |

Values are cumulative since the cursor was loaded (`V$SQLAREA`). Statements issued by the performance tools
themselves (`MODULE=oracle-mcp-server-perf`) are excluded.

```text
SQL_ID          PLAN_HASH  SCHEMA  EXECS  ELAPSED_S  CPU_S  MS/EXEC     GETS  READS  ROWS  LAST_ACTIVE          SQL_TEXT
─────────────  ──────────  ──────  ─────  ─────────  ─────  ───────  ───────  ─────  ────  ───────────────────  ────────
07tta3zsajw96  1029575276  MCP      1638      38.95  38.54    23.78  1835410      1  1638  2026-09-25 19:05:00  SELECT /*+ cpu_burner */ …
```

### session_activity

| Parameter | Default | Description |
|-----------|---------|-------------|
| `include_idle` | `false` | include INACTIVE sessions |
| `username` | – | only sessions of this user |
| `limit` | 50 | max. 100 |

Blocked sessions are listed first; the `BLOCKER` column holds the blocking SID. The second table shows the
top 10 non-idle wait events since instance startup (`V$SYSTEM_EVENT`).

```text
Sessions (2 active, 1 blocked):
SID  SERIAL#  USER  STATUS  SQL_ID         EVENT                          WAIT_CLASS   WAIT_S  CALL_S  BLOCKER …
218    13014  MCP   ACTIVE  fadvtpv7q5rxh  enq: TX - row lock contention  Application    40.7      41       64 …
 64    24782  MCP   ACTIVE  b9aamyrr492wp  PL/SQL lock timer              Idle           43.7      44          …
```

### table_stats

| Parameter | Default | Description |
|-----------|---------|-------------|
| `table` | required | table name (unquoted → upper case) |
| `schema` | current schema | owner |

Shows rows, blocks, sample size, last analyzed, **stale** and **locked** flags (with warnings for missing or
stale statistics), all indexes with columns, B-tree level, leaf blocks, distinct keys, clustering factor,
status and visibility, and per-column distinct values, nulls, density, buckets and histogram type.

### ash_top — Diagnostics Pack

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minutes` | 15 | window, 1–1440 (in-memory ASH typically covers the last hour or so) |
| `group_by` | `sql_id` | `sql_id`, `event`, `wait_class`, `session`, `module` |
| `limit` | 10 | max. 100 |

One ASH sample ≈ one second of DB time; the header shows the average number of active sessions.

```text
ASH last 5 min by event: 166 samples ≈ 166s DB time, average active sessions 0.55
SAMPLES   PCT  WAIT_CLASS   EVENT
    121  72.9  Application  enq: TX - row lock contention
     44  26.5  CPU          ON CPU
```

### awr_top_events — Diagnostics Pack

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hours` | 24 | window, 1–720; the first and last snapshot inside the window are compared |
| `limit` | 10 | max. 100 |

Shows DB time, DB CPU and the top non-idle wait events with their share of DB time. Windows containing an
instance restart are refused. In a PDB the PDB's own snapshots are used (`AWR_PDB_AUTOFLUSH_ENABLED = TRUE`
or manual `DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT` in the PDB); otherwise CDB root snapshots are used
where their statistics are visible, else the tool explains why no data is available.

```text
Instance 1 (dbid 3182349174), snapshots 1–2 (2026-09-25 18:59 – 2026-09-25 19:07)
DB time 65.9s, DB CPU 19.2s
TIME_S  %DBTIME  WAITS    AVG_MS  WAIT_CLASS     EVENT
  45.9     69.7      1  45935.26  Application    enq: TX - row lock contention
  19.2     29.1                   CPU            DB CPU
```

### sql_monitor — Tuning Pack

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sql_id` | – | omitted: list recent monitored executions; given: text report of the last execution |
| `limit` | 10 | list size, max. 100 |

Oracle monitors statements automatically when they run in parallel or consume more than 5 seconds of CPU
or I/O, or when they carry the `/*+ MONITOR */` hint.

---

## Typical workflows

**A statement is slow**
1. `top_sql` with `sql_text_like` (or `order_by: "elapsed_per_exec"`) → `sql_id`
2. `sql_plan` with that `sql_id` (re-run with `/*+ GATHER_PLAN_STATISTICS */` and use `format: "ALLSTATS LAST"`
   to compare estimated vs. actual rows)
3. `table_stats` for the tables with bad estimates (stale / missing statistics, missing histograms, index clustering)
4. `explain_plan` to check a rewritten statement or hints before running it

**Something is blocking**
- `session_activity` → blocked sessions first, `BLOCKER` shows the SID holding the lock

**The database was slow (licensed)**
- `ash_top` with `group_by: "wait_class"` → then `event` / `sql_id` for the last minutes
- `awr_top_events` for the last hours; `sql_monitor` for long-running statements

---

## Database settings that matter

| Setting | Relevance |
|---------|-----------|
| `CONTROL_MANAGEMENT_PACK_ACCESS` | `NONE` disables ASH/AWR/SQL Monitor collection in the database; `DIAGNOSTIC` or `DIAGNOSTIC+TUNING` as licensed. The licensed tools mention it when they find no data. |
| `STATISTICS_LEVEL` | `TYPICAL` (default) is required for AWR/ASH; `ALL` collects row source statistics for every statement (costly — prefer the hint). |
| `AWR_PDB_AUTOFLUSH_ENABLED` | Enables automatic PDB-level AWR snapshots (default `FALSE` in 19c). |
| Shared pool size | Cursors age out; `sql_plan` needs the cursor to be cached. |

---

## Troubleshooting

| Message | Cause / fix |
|---------|-------------|
| `Tool "ash_top" is disabled: requires the Oracle Diagnostics Pack licence …` | Switch not enabled — set `ORA_DIAGNOSTICS_PACK=true` or the token's `diagnostics_pack` (only when licensed). |
| `ORA-00942: table or view "SYS"."V_$…" does not exist` + hint | Missing grant — run the grant script and restart the server. |
| `User has no SELECT privilege on V$SQL` | `sql_plan` without grants on the V$ views used by `DISPLAY_CURSOR`. |
| `No SQL Monitor data for sql_id …` | Statement not monitored or aged out, or missing `SELECT` on `V$SQL_MONITOR` / `V$SQL_PLAN_MONITOR`. |
| `SQL_ID … cannot be found` / `cannot fetch plan` | Cursor aged out of the shared pool, or the `sql_id` is a PL/SQL block. |
| `No ASH samples in the last … minutes` | No activity, or collection disabled (`CONTROL_MANAGEMENT_PACK_ACCESS`). |
| `only one snapshot in the window` | Increase `hours` or create a snapshot. |
| `statistics of this dbid are not visible from the current container` | In a PDB without PDB-level snapshots — enable `AWR_PDB_AUTOFLUSH_ENABLED` or connect to the CDB root. |
| Privileges granted but still `ORA-00942` | The pooled sessions were opened before the grant — restart the server; check the role is a default role ([Roles vs. direct grants](#roles-vs-direct-grants)). |
| A V$ view works in `query`, but `ORA-00942` inside your own procedure/view | Roles are disabled in definer-rights objects — grant directly to the owner or use `AUTHID CURRENT_USER` ([caveat 4](#roles-vs-direct-grants)). |
