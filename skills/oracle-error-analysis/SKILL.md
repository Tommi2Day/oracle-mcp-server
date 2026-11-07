---
name: oracle-error-analysis
description: Analyse Oracle errors (ORA-xxxxx, TNS, ORA-00600/07445, deadlocks, tablespace, undo, memory errors) with the alert log, incidents and trace files. Use when the user reports an ORA- error, a crash or hang, asks to check the alert log or trace files, or wants a root-cause analysis of a database error.
---

# Oracle error analysis (alert log, incidents, trace files)

Works from the symptom to the root cause: error → alert log → incident → trace file → statement/session →
cause. Read-only; uses `alert_log`, `incidents`, `trace_files`, `trace_content` and the performance tools of the
oracle-mcp-server.

## Ground rules

- The log tools need the privileges of the optional `MCP_PERF_LOG_ROLE` (or `SELECT_CATALOG_ROLE`). On
  `ORA-00942` / `ORA-01031` say so and point to `scripts/sql/grant_perf_privileges.sql … logs` — do not guess
  what the log would have said.
- **Trace files may contain SQL text, bind values and data.** Read only what is needed (`contains`, small
  `lines`), never paste long passages into the answer, never copy values into documentation or tickets.
- Do not claim a root cause for `ORA-00600`/`ORA-07445`/`ORA-00700` from the first argument alone: report the
  evidence and recommend an Oracle Support service request with the incident (the ADR incident package is created
  with `adrci`, outside these tools).
- What the tools cannot see: the listener log, OS logs, other RAC instances (only the connected instance), and
  client-side errors (`ORA-12154`, `ORA-12541`, `ORA-12514` happen before a session exists — they are not in the alert log).

## Workflow

1. **Pin down the error.** Exact code(s), message, time (with time zone), user/application, statement if known.
   Ask for what is missing only if it blocks the next step.
2. **Alert log** — `alert_log`:
   - around the event: `minutes` covering it, `errors_only: true`;
   - by code: `contains: "ORA-01555"`;
   - broader context: the same window without `errors_only` (checkpoint, archiving, startup, parameter changes
     appear as plain lines).
   "Errors in file …" lines carry the trace file in the `TRACE_FILE` column; `PROBLEM_KEY` links to incidents.
3. **Incidents** — `incidents` (`days`): incident id, error code, problem key, signalling component. Several incidents
   with the same problem key are one problem occurring repeatedly (note the first and last time).
4. **Trace files** — `trace_files` with `name_like` (file from the alert log, an OS pid, `_m000_`, `_j00`, an
   incident number) and `minutes`; then `trace_content`:
   - `position: "head"` for incident traces (error stack, call stack, current SQL are at the top);
   - `contains: "ORA-"`, `"Current SQL"`, `"sql_id"`, `"Deadlock graph"` to jump to the relevant part — add
     `context` (lines before/after each match, like `grep -C`, e.g. `context: 14, lines: 40` for a deadlock graph),
     otherwise only the matching line itself is returned; `--` separates distant blocks;
   - `position: "tail"` for what happened last in a process trace.
5. **Follow the leads** into the database: a `sql_id` → `sql_plan`, `top_sql`; a session/module → `session_activity`;
   resource errors → `db_overview`, `table_stats`, `query` on the dictionary (see table below).
6. **Conclude** with confirmed cause, contributing factors, and what is still unknown.

## Common errors — where to look

| Error | Meaning | Check |
|-------|---------|-------|
| ORA-00060 deadlock detected | two sessions lock each other (application ordering) | `trace_content` with `contains: "Deadlock graph"`, `context: 14` shows blockers/waiters (session, serial, held/waited resource); `contains: "UPDATE"`/`"SELECT"` shows the statements; fix the lock order in the application, index missing on FK (TM locks) |
| ORA-00054 resource busy | NOWAIT lock or DDL on a busy object | `locks` for the holder |
| ORA-01555 snapshot too old | undo overwritten during a long query | long-running statement (`top_sql`, `sql_plan`), undo size/retention: `query` `v$undostat`, `v$parameter` `undo_retention` |
| ORA-01652 / 01653 / 01654 / 01688 | tablespace or temp full | `query` `dba_free_space`/`dba_data_files`/`v$tempseg_usage`; who uses temp: `session_activity` |
| ORA-04031 | shared pool/large pool memory | alert + trace summary; hard-parse storm (`top_sql` many unique statements, no binds); SGA parameters |
| ORA-04030 / ORA-04036 | process/PGA memory | sessions with large work areas, `pga_aggregate_limit` |
| ORA-00018 / 00020 | max sessions / processes | `db_overview` sessions, connection leaks per machine/module (`session_activity`) |
| ORA-00257 | archiver stuck (FRA/dest full) | alert log lines before; `query` `v$recovery_area_usage`, `v$flash_recovery_area_usage` |
| ORA-01017 / 28000 / 28001 / 28002 | login failures, locked or expiring account | `query` `dba_users` (account_status, lock_date, expiry_date) if privileged; count of failures in alert/audit |
| ORA-03113 / 03114 / 03135 | connection lost | alert log around the time (crash? ORA-00600/07445?), network/firewall idle timeouts |
| ORA-00600 / 07445 / 00700 | internal error | incident + trace head: first argument, call stack, current SQL; known-bug lookup is a Support task |
| ORA-12170 / 12541 / 12514 | connect problems | not visible here (listener, network, service name) — say so |
| ORA-02049 timeout: distributed transaction | lock wait over a DB link | `locks` on both sides |
| ORA-30036 | undo tablespace full | `query` `dba_undo_extents`, long transactions (`v$transaction` if granted) |

## Reading an incident trace

Typical order: header (instance, pid, time) → `*** ... ***` markers → `ORA-` error line(s) →
"Current SQL Statement" / `sql_id` → call stack (`ksedst`, `kgeriv`… — module names help Support, not you) →
process state / enqueues. Report: error + arguments, the statement (sanitised), the session's module/program,
the time, and whether the same problem key recurs.

## Answer format

```
Error:      <code and message>, first/last seen, count (alert log), incident ids
Where:      process / session / module / sql_id (from alert or trace)
Cause:      confirmed (with evidence: log line, trace line, number) | probable | unknown
Impact:     what failed, for whom, ongoing or one-off
Fix:        immediate action, permanent action, owner
Not visible: what could not be checked and how to check it (listener log, OS, other instance)
```

If the incident indicates an Oracle bug (ORA-00600/07445), end with the Support hand-over: incident id(s), problem key,
version (`test_connection`/`db_overview`), time of occurrence, and the statement from the trace.
