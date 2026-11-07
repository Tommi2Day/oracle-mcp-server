---
name: oracle-problem-detection
description: Detect problematic situations in an Oracle database — blocking locks, deadlocks, idle-in-transaction sessions, wait events, CPU or I/O saturation, long-running calls, stale statistics, resource errors. Use when the user reports hangs, slowness, timeouts, "stuck" sessions or asks for a health check or problem scan of an Oracle database.
---

# Detecting problems in an Oracle database

Systematic scan with the oracle-mcp-server tools. Every finding needs evidence from a tool result — do not
report a problem you only suspect.

## Ground rules

- Read-only. `ALTER SYSTEM KILL SESSION` and any `execute` call only after the user explicitly agrees, and only
  for the session they confirmed (the `locks` tool prints the statement but never runs it).
- Licensed tools (`ash_top`, `awr_top_events`, `sql_monitor`) only if they are in the tool list.
- Rank findings by impact: something that blocks work > resource exhaustion > degradation > housekeeping.

## Scan

1. `db_overview` — blocked sessions, longest active call, load vs. CPU count, wait classes.
2. `locks` — whenever something is blocked, or the user reports "hanging" sessions. Look at the **root
   blockers**, not the waiters.
   - Root blocker `INACTIVE` with a growing `CALL_S` → uncommitted transaction in an idle client
     (application bug, forgotten commit, debugger). Fix: owner commits/rolls back.
   - Root blocker `ACTIVE` on CPU/IO → a long statement holds the lock; look at its `sql_id` with `sql_plan`.
   - Many waiters on one root blocker → one fix clears them all.
   - No blocked sessions but timeouts reported → deadlocks (ORA-00060) are resolved immediately and only show in the
     alert log: `alert_log` with `contains: "ORA-00060"`; the trace file lists both statements (`trace_content`).
3. `session_activity` — waits of active sessions and top wait events (cumulative!). Use the cheat-sheet below.
4. `top_sql` (`cpu`, `buffer_gets`, `elapsed_per_exec`) for load that is explained by statements; then
   `oracle-sql-tuning`.
5. `alert_log` with `errors_only: true`, `minutes: 1440` and `incidents` — errors that explain the symptoms;
   continue with `oracle-error-analysis` for any ORA-00600/07445 or resource error.
6. Statistics: `table_stats` for the tables of the slow statements — stale or missing statistics, locked
   statistics, missing indexes.
7. With licences enabled: `ash_top` (`group_by: "wait_class"`, then `"event"`, `"sql_id"`) for the slow window,
   `awr_top_events` for the last hours, `sql_monitor` for long-running statements.

## Wait event cheat-sheet

| Event / class | Usually means | Look at |
|---------------|---------------|---------|
| `enq: TX - row lock contention` | session waits for another's uncommitted row change | `locks` |
| `enq: TM - contention` | missing index on a foreign key, or DDL against a busy table | `locks`, FK indexes |
| `enq: TX - index contention`, `buffer busy waits`, `latch`/`mutex` (Concurrency) | hot block / hot index / many sessions on one object | `top_sql` for the object, `ash_top` by sql_id |
| `library cache lock/pin`, `cursor: pin S wait on X` | DDL or invalidations while code runs; hard-parse storms | recent DDL, `top_sql` `sql_text_like` for literal-only duplicates |
| `log file sync` | slow commits — redo I/O, or commit after every row | commit frequency, redo disk |
| `log file switch (checkpoint incomplete)` / `(archiving needed)` | redo too small or archiver stuck | `alert_log` for ORA-00257 |
| `db file sequential read` | single-block reads (indexes) — normal unless dominant | plan of top SQL, `buffer_gets` |
| `db file scattered read`, `direct path read` | full scans | plans, missing indexes, stats |
| `free buffer waits`, `write complete waits` | DB writer / I/O cannot keep up | storage latency |
| `resmgr:cpu quantum` | Resource Manager throttling | consumer groups / plan |
| `SQL*Net message from client` (Idle) | database waits for the application | not a DB problem |
| `ON CPU` | working | AAS vs. CPU count |

Interpretation rule: a few seconds of a wait in `V$SYSTEM_EVENT` since startup means nothing; what counts is
what **active sessions wait on now** and, with ASH, the share of DB time in the problem window.

## Threshold hints (guidance, not law)

- AAS > CPU count: CPU saturated or queuing. Host CPU > 90% sustained: investigate SQL first, then OS.
- Active call > 5 min without progress: long query, lock wait or stuck client — decide with `locks`/`sql_plan`.
- Blocked time growing: escalate to the user — each minute blocks application work.

## Answer format

```
Findings (most important first):
 1. <title> — impact — evidence (tool, numbers, SIDs / sql_ids)
    Cause:  <what is actually going on>
    Action: <what to do and who must do it; kill statements only as an option with the warning>
 2. …
Checked, nothing found: <list>
Could not check: <missing privileges / unlicensed tools>
```
