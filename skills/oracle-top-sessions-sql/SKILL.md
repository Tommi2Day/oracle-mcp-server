---
name: oracle-top-sessions-sql
description: Find the top sessions and top SQL statements of an Oracle database — who uses the most CPU, time, I/O or executions, and which statements cause it. Use when the user asks for top sessions, top SQL, the most expensive queries, heavy users, or "who is hogging the database".
---

# Top sessions and top SQL

Ranks what consumes the database, from "now" (sessions) and "since the cursor was loaded" (SQL), and
connects the two through `sql_id`. Read-only.

## Ground rules

- `session_activity` is a **snapshot** of right now. `top_sql` is **cumulative** per cursor since it entered the
  shared pool (`V$SQLAREA`) — old and new load are mixed, aged-out statements are gone.
- `ash_top` (Diagnostics Pack) gives a time window and is the better source for "the last 15 minutes" — use it
  only if it is in your tool list.
- Never run `execute`; never kill sessions. Mention SQL text carefully: it can contain business data in literals.

## Steps

### Top sessions (now)

1. `session_activity` (default: active sessions, blocked first). Use `username` to focus on one user and
   `include_idle: true` only when looking for idle-in-transaction sessions.
2. Read each row as: *who* (user, machine, module, program), *doing what* (`sql_id`, call duration `CALL_S`),
   *waiting for what* (event / wait class, `WAIT_S`), *blocked by whom* (`BLOCKER`).
3. Rank by the question: longest `CALL_S` for runaway calls, most sessions per user/module for heavy users,
   non-zero `BLOCKER` first for blocking problems (then use `locks`).
4. With `ash_top` available: `group_by: "session"` and `"module"` for the last N minutes, sample counts ≈
   seconds of DB time.

### Top SQL

Run `top_sql` more than once — each ordering answers a different question:

| `order_by` | Answers |
|------------|---------|
| `elapsed` | what the database spent the most wall-clock time on overall |
| `cpu` | CPU consumers |
| `buffer_gets` | logical I/O heavy statements (often bad plans, missing indexes) |
| `disk_reads` | physical I/O heavy statements |
| `executions` | very frequent statements (death by a thousand cuts, missing bind variables) |
| `elapsed_per_exec` | statements that are slow *per call* — what a user feels |

Filters: `schema`, `sql_text_like`, `include_system: true` for SYS recursive SQL, `limit` up to 100.

For a statement of interest: `sql_plan` with its `sql_id`; for the owner session look it up in
`session_activity` by `sql_id`.

## Interpreting

- `ELAPSED_S` far above `CPU_S` → the statement spent its time **waiting** (row locks, I/O, latches), not computing.
  A one-off `UPDATE` with 3 s elapsed and 0.1 s CPU is a lock wait — look at `locks` / the alert log, do not tune the SQL.
- Recursive and housekeeping statements (`SYS.NLS_SESSION_PARAMETERS`, `DBMS_STATS` internals, `BEGIN … END` blocks) can rank
  high on a quiet system; narrow with `schema` / `sql_text_like` and say that you ignored them.
- `ELA_MS_EXEC` high and `EXECS` low → a few heavy statements; low per exec but huge total → frequency problem.
- `GETS` / row processed very high → scanning far more than returning; check plan and statistics.
- Many near-identical statements differing in literals (many rows, `EXECS = 1`, same text pattern) → missing
  bind variables, shared pool pressure (`sql_text_like` helps to count them).
- The same `sql_id` with several `plan_hash_value`s → plan instability; compare plans with `sql_plan`
  (`child_number`).
- Statements of the monitoring/MCP user itself are excluded already.

## Answer format

```
Top sessions now:  table (SID/user/module/sql_id/wait/seconds) — 3–5 rows, with one line of reading
Top SQL by <metric>: table (sql_id, execs, ela/exec, gets, schema, text start) — per question asked
Conclusion: which 1–3 statements/sessions matter and why (use numbers and share of total)
Next: tune <sql_id> (→ oracle-sql-tuning) | investigate blocker (→ oracle-problem-detection)
```

Offer tuning for the top statement instead of starting it unasked; show the SQL text only as far as needed.
