---
name: oracle-sql-tuning
description: Tune a slow Oracle SQL statement — find it, read its real execution plan, compare estimated and actual rows, check optimizer statistics and indexes, propose and verify improvements. Use when the user has a slow query, a sql_id, an execution plan to interpret, or asks how to make an Oracle statement faster.
---

# Oracle SQL tuning

Evidence first: plan, statistics, row counts. Recommendations are verified with `explain_plan` before the
user applies anything. Uses the oracle-mcp-server tools; nothing is changed in the database by this skill.

## Ground rules

- Do not run DDL, `DBMS_STATS`, SQL plan baselines, hints in production code or any `execute` call. Propose
  them with the exact statement, expected effect and risk; the user decides and runs them (or explicitly asks you).
- `query` only reads (SELECT/WITH, read-only transaction). It runs the statement for real — warn before running
  a statement that may take minutes, and add `FETCH FIRST n ROWS ONLY` when a sample is enough.
- `sql_monitor` (Tuning Pack) and `ash_top` only if they are in the tool list.
- SQL text and literals may be business data — quote only what is needed.

## Workflow

1. **Identify the statement.** The user gives a `sql_id`, or SQL text, or a description.
   - `top_sql` with `sql_text_like` (a distinctive fragment) or `order_by: "elapsed_per_exec"` → `sql_id`.
   - Note executions, time per execution, buffer gets, rows — is it slow per call or called too often?
2. **Actual plan.** `sql_plan` with the `sql_id` (`child_number` if several children). It shows the plan the
   optimizer really used, including peeked binds. For estimated vs. **actual** rows run the statement once
   with the hint `/*+ GATHER_PLAN_STATISTICS */` through `query` — wrap it as
   `SELECT /*+ GATHER_PLAN_STATISTICS */ COUNT(*) FROM (<statement>)` so the whole statement runs (`query` caps the
   rows it returns, a capped fetch gives partial row counts). The hint changes the text, so the run gets its own
   `sql_id`: find it with `top_sql` and `sql_text_like: "GATHER_PLAN_STATISTICS"`, then call `sql_plan` with
   `format: "ALLSTATS LAST"`. With the Tuning Pack: `sql_monitor` with the `sql_id`.
3. **Read the plan** (see checklist). Find the step where time or rows explode: the biggest actual-row
   deviation from estimate (`E-Rows` vs. `A-Rows`), the most `Buffers`, the widest cost jump.
4. **Statistics and structure.** `table_stats` for each table in the hot steps: row count vs. what the plan
   assumes, `STALE`/missing/locked statistics, histograms on skewed filter columns, available indexes (columns,
   order, clustering factor, status, visibility), column distinct counts and nulls.
5. **Hypothesis → change → verify.** Formulate one cause (e.g. "optimizer estimates 1 row but 2 million come
   back because the histogram on STATUS is missing"). Propose the smallest fix. Verify the effect on the plan with
   `explain_plan` of the rewritten SQL (or of the statement after the proposed index is *imagined* — say clearly
   that `explain_plan` cannot see an index that does not exist yet; reason about the access path instead).
6. **After the user applied a change** (new index, fresh statistics): run `table_stats` and `explain_plan` again and
   compare plan hash, access paths and estimated rows with the "before" plan; with `ALLSTATS LAST` compare actual rows.
7. **Report** with before/after plan facts and the exact statements for the user to apply and test.

If `top_sql` finds nothing for a statement the user just ran, the cursor may have aged out of the shared pool
(small SGA, `ALTER SYSTEM FLUSH`, invalidation): ask to run it again, or fall back to the SQL text with `explain_plan`.

## Plan reading checklist

| Observation | Typical cause | Typical fix |
|-------------|---------------|-------------|
| `TABLE ACCESS FULL` of a big table with a selective filter | no usable index, function on column, implicit conversion, stale stats | index, rewrite the predicate (`col = :b` instead of `TO_CHAR(col) = …`), gather stats |
| Estimated rows ≪ actual rows | missing/stale stats, skew without histogram, correlated columns | gather stats (histogram), extended statistics, dynamic sampling |
| `NESTED LOOPS` with a huge outer row source | wrong cardinality, missing hash-join choice | fix estimates first; hash join hint only as last resort |
| `HASH JOIN` spilling (temp, `OMem`/`1Mem` vs. `Used-Tmp`) | big build side, small PGA | filter earlier, PGA/work area sizing |
| `MERGE JOIN CARTESIAN` | missing join condition | fix the SQL |
| `INDEX FULL SCAN` + `SORT` / `COUNT STOPKEY` missing | pagination without matching index | composite index matching `WHERE` + `ORDER BY` |
| `FILTER` with repeated subquery executions | correlated subquery | rewrite as join / `EXISTS` / analytic function |
| High `Starts` on inner step | row-by-row work inside a loop | set-based rewrite |
| `INDEX RANGE SCAN` + many `TABLE ACCESS BY INDEX ROWID`, huge clustering factor | poor clustering | covering index, partitioning, accept |
| Different `plan_hash_value` per child | bind peeking, adaptive cursor sharing, stats change | compare children; baseline once a good plan exists |
| `Note: dynamic statistics used`, `adaptive plan` | missing stats / adaptive feature | gather stats; understand `ADAPTIVE` plan at `+ADAPTIVE` |
| Hard-parse flood (many one-off statements) | literals instead of binds | bind variables (application change) |

## Recommendations — how to phrase them

Give each as: *what* (exact statement), *why* (evidence from the plan/stats), *expected effect*, *risk and
rollback*. Typical, from least to most invasive:

1. Fresh statistics on the affected table, only after checking that locked/stale stats are the cause:
   `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => 'S', tabname => 'T', method_opt => 'FOR ALL COLUMNS SIZE AUTO'); END;`
   (invalidates cursors — plans may change; do it off-peak).
2. SQL rewrite: sargable predicates, avoid implicit conversion, `EXISTS` instead of `IN` with correlated
   subquery where it helps, remove unnecessary `DISTINCT`/`ORDER BY`.
3. Index: composite in `WHERE`-equality-first order, then range/`ORDER BY` columns; check write overhead and
   that an existing index is not just made invisible/unusable.
4. Extended statistics (column groups) for correlated predicates.
5. SQL plan baseline / SQL profile to pin a known good plan (`DBMS_SPM`, SQL Tuning Advisor needs the Tuning
   Pack) — only when the cause cannot be fixed at the source.
6. Hints in application code — last resort; document why.

Never say "this will be faster" without a plan fact behind it; say what you expect and how to measure.

## Answer format

```
Statement: sql_id, schema, execs, ela/exec, gets (from top_sql)
Where the time goes: plan step(s) with estimated vs. actual rows, buffers
Root cause: one sentence with evidence
Recommendation(s): numbered, each with statement, effect, risk
Verification: how to confirm (explain_plan result, timing before/after, plan_hash_value)
```
