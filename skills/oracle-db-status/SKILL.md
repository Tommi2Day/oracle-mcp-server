---
name: oracle-db-status
description: Answer "what is my Oracle database doing right now?" — health, load, busy or slow. Use when the user asks about the current state of an Oracle database, whether it is healthy, why it feels slow, or wants a quick check of an Oracle instance through the oracle-mcp-server tools.
---

# What is my Oracle database doing?

Gives a short, evidence-based status of the connected database. Uses only read-only tools of the
oracle-mcp-server (in Claude Code they are named `mcp__<server>__<tool>`).

## Ground rules

- Read-only: never call `execute`, and never suggest `ALTER SYSTEM KILL SESSION` as something you ran.
- `ash_top`, `awr_top_events` (Diagnostics Pack) and `sql_monitor` (Tuning Pack) are only listed when the
  server operator enabled them for a licensed database. If they are not in your tool list, do not try them and
  do not suggest enabling them unless the user asks about licensing.
- Say what you could **not** see (missing privilege, view not available) instead of guessing.

## Steps

1. `test_connection` — which database, container, user and schema this is. Name them in the answer, so the
   user knows which system you looked at.
2. `db_overview` — instance, uptime, load of the last minute, session counts, CPU vs. wait classes and
   attention points. This is the main source for the verdict.
3. Follow the attention points, only as far as needed:

   | Finding in `db_overview` | Next tool |
   |--------------------------|-----------|
   | sessions blocked | `locks` |
   | active sessions mostly waiting in one class | `session_activity` (events, SQL, blockers) |
   | CPU high, or many sessions on CPU | `top_sql` with `order_by: "cpu"`, then `oracle-top-sessions-sql` |
   | long active call | `session_activity`, then `sql_plan` for its `sql_id` |
   | nothing unusual but the user reports slowness | `top_sql` `order_by: "elapsed_per_exec"`, `alert_log` with `errors_only: true` for the last hour |

4. Check for recent trouble: `alert_log` with `errors_only: true`, `minutes: 60`. A privilege error means the
   log tools were not granted — note it, continue.

## Answer format

```
Database: <instance / container, version>, up <n> days, user <user>
Verdict:  healthy | busy | degraded | problem   — one sentence why
Evidence: 3–5 bullets with the actual numbers (AAS vs. CPUs, blocked sessions, top wait class, top SQL, errors)
Next:     the one or two most useful follow-ups (e.g. "tune sql_id abc… → oracle-sql-tuning")
```

Verdict guide: **healthy** — no blocked sessions, AAS well below the CPU count, no recent errors;
**busy** — high but explained load, nothing blocked; **degraded** — sustained waits, long calls or
errors without outage; **problem** — blocked sessions, resource exhaustion or errors that stop work.

## Pitfalls

- `V$SYSTEM_EVENT` and `top_sql` are cumulative since instance start / cursor load — large old numbers are
  not a current problem. The current picture is `db_overview` and `session_activity`.
- "Idle" wait classes (`SQL*Net message from client`) mean the session waits for the application, not the database.
- In a PDB, `V$SYSMETRIC` can be empty; `db_overview` then falls back to a session sample — say so.
- One snapshot is not a trend. For "was it slow earlier" you need ASH/AWR (licensed) or the alert log.
