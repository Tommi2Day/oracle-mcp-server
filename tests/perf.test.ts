import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("oracledb", () => ({
  default: { OUT_FORMAT_OBJECT: 4002, STRING: 2001 },
}));

import { runPerfTool, perfToolList, assertPerfToolEnabled, PERF_TOOLS, SQL_TAG } from "../src/perf.js";
import { formatTable } from "../src/format.js";
import { perfFeatures, firstKeyword } from "../src/oracle.js";

const ALL = { perf: true, diagnostics: true, tuning: true };
const conn: { execute: any; rollback: any; module?: string; action?: string } =
  { execute: vi.fn(), rollback: vi.fn().mockResolvedValue(undefined) };
const run = (name: string, args: Record<string, unknown> = {}, features = ALL) =>
  runPerfTool(name, args, conn as any, features);
const sqlOf = (i: number) => String(conn.execute.mock.calls[i][0]);
const bindsOf = (i: number) => conn.execute.mock.calls[i][1];

beforeEach(() => {
  conn.execute.mockReset();
  conn.rollback.mockClear();
});

describe("feature switches", () => {
  it("perfFeatures defaults: unlicensed on, packs off", () => {
    expect(perfFeatures({}, {})).toEqual({ perf: true, diagnostics: false, tuning: false });
  });
  it("token/env values enable packs; ORA_PERF_TOOLS=false disables everything", () => {
    expect(perfFeatures({ diagnostics_pack: "true", tuning_pack: true }, {})).toEqual({ perf: true, diagnostics: true, tuning: true });
    expect(perfFeatures({ diagnostics_pack: true, tuning_pack: true }, { ORA_PERF_TOOLS: "false" }))
      .toEqual({ perf: false, diagnostics: false, tuning: false });
  });
  it("perfToolList filters by feature", () => {
    expect(perfToolList({ perf: true, diagnostics: false, tuning: false }).map(t => t.name))
      .toEqual(["explain_plan", "sql_plan", "top_sql", "session_activity", "table_stats", "db_overview", "locks", "alert_log", "incidents", "trace_files", "trace_content"]);
    expect(perfToolList(ALL)).toHaveLength(PERF_TOOLS.length);
    expect(perfToolList(ALL)[0]).not.toHaveProperty("feature");
  });
  it("disabled tools throw with a licence hint and never execute SQL", async () => {
    const off = { perf: true, diagnostics: false, tuning: false };
    await expect(run("ash_top", {}, off)).rejects.toThrow(/Diagnostics Pack/);
    await expect(run("awr_top_events", {}, off)).rejects.toThrow(/ORA_DIAGNOSTICS_PACK/);
    await expect(run("sql_monitor", {}, off)).rejects.toThrow(/Tuning Pack/);
    await expect(run("top_sql", {}, { perf: false, diagnostics: false, tuning: false })).rejects.toThrow(/ORA_PERF_TOOLS/);
    expect(conn.execute).not.toHaveBeenCalled();
    expect(() => assertPerfToolEnabled("nope", ALL)).toThrow(/Unknown tool/);
  });
});

describe("explain_plan", () => {
  it("explains on one connection with a generated statement id and rolls back", async () => {
    conn.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ LINE: "Plan hash value: 1" }, { LINE: "| 0 |" }] });
    const out = await run("explain_plan", { sql: "select * from emp where id = :1;" });
    expect(sqlOf(0)).toBe("BEGIN EXECUTE IMMEDIATE :stmt; END;");
    expect(bindsOf(0).stmt).toMatch(/^EXPLAIN PLAN SET STATEMENT_ID = 'MCP[0-9A-F]{24}' FOR select \* from emp where id = :1$/);
    expect(conn.action).toBe("mcp-perf:explain_plan"); // tool statements are tagged via ACTION
    expect(conn.execute.mock.calls.length).toBe(2);
    expect(sqlOf(1)).toContain("DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, :fmt)");
    expect(bindsOf(1)).toMatchObject({ fmt: "TYPICAL" });
    expect(out).toBe("Plan hash value: 1\n| 0 |");
    expect(conn.rollback).toHaveBeenCalled();
  });
  it("rejects DDL, PL/SQL and malicious formats", async () => {
    await expect(run("explain_plan", { sql: "DROP TABLE t" })).rejects.toThrow(/supports SELECT/);
    await expect(run("explain_plan", { sql: "BEGIN NULL; END;" })).rejects.toThrow(/supports SELECT/);
    await expect(run("explain_plan", { sql: "select 1 from dual", format: "ALL'; drop" })).rejects.toThrow(/Invalid DBMS_XPLAN format/);
    expect(conn.execute).not.toHaveBeenCalled();
  });
  it("does not add the privilege hint to explain_plan errors", async () => {
    conn.execute.mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"));
    await expect(run("explain_plan", { sql: "select * from nope" })).rejects.toThrow(/^ORA-00942: table or view does not exist$/);
  });
});

describe("sql_plan", () => {
  it("validates the sql_id and passes child/format binds", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ LINE: "x" }] });
    await run("sql_plan", { sql_id: "0abcd1234efgh", child_number: 2, format: "ALLSTATS LAST" });
    expect(sqlOf(0)).toContain("DBMS_XPLAN.DISPLAY_CURSOR(:id, :child, :fmt)");
    expect(bindsOf(0)).toEqual({ id: "0abcd1234efgh", child: 2, fmt: "ALLSTATS LAST" });
    await expect(run("sql_plan", { sql_id: "short" })).rejects.toThrow(/Invalid sql_id/);
  });
  it("defaults to all child cursors", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [] });
    await run("sql_plan", { sql_id: "0abcd1234efgh" });
    expect(bindsOf(0)).toMatchObject({ child: null, fmt: "TYPICAL +PEEKED_BINDS" });
  });
  it("adds a privilege hint on ORA-00942", async () => {
    conn.execute.mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"));
    await expect(run("sql_plan", { sql_id: "0abcd1234efgh" })).rejects.toThrow(/SELECT_CATALOG_ROLE/);
  });
});

describe("top_sql", () => {
  it("uses a whitelisted ORDER BY, filters and the SQL tag", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ SQL_ID: "a", EXECUTIONS: 3, ELAPSED_S: 1.5, SQL_TEXT: "select 1" }] });
    const out = await run("top_sql", { order_by: "buffer_gets", schema: "hr", sql_text_like: "emp", limit: 500 });
    expect(sqlOf(0).startsWith(SQL_TAG)).toBe(true);
    expect(sqlOf(0)).toContain("NVL(action, '-') NOT LIKE 'mcp-perf:%'");
    expect(sqlOf(0)).toContain("ORDER BY buffer_gets DESC");
    expect(bindsOf(0)).toEqual({ inc_sys: 0, schema_name: "HR", pattern: "emp", n: 100 });
    expect(out).toContain("Top 1 SQL by buffer_gets");
    expect(out).toContain("select 1");
  });
  it("rejects unknown sort keys", async () => {
    await expect(run("top_sql", { order_by: "1; drop" })).rejects.toThrow(/Invalid order_by/);
  });
  it("reports an empty shared pool result", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [] });
    expect(await run("top_sql")).toMatch(/No matching statements/);
  });
});

describe("session_activity", () => {
  it("shows sessions, blocked count and system waits", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [
        { SID: 10, SERIAL: 1, USERNAME: "APP", STATUS: "ACTIVE", EVENT: "enq: TX - row lock contention", BLOCKING_SESSION: 11 },
        { SID: 11, SERIAL: 2, USERNAME: "APP", STATUS: "ACTIVE", EVENT: "ON CPU", BLOCKING_SESSION: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ EVENT: "db file sequential read", WAIT_CLASS: "User I/O", TIME_S: 12.5 }] });
    const out = await run("session_activity", { username: "app" });
    expect(bindsOf(0)).toMatchObject({ idle: 0, username: "APP", n: 50 });
    expect(out).toContain("Sessions (2 active, 1 blocked):");
    expect(out).toContain("enq: TX - row lock contention");
    expect(out).toContain("db file sequential read");
  });
});

describe("db_overview", () => {
  const INSTANCE = { INSTANCE_NAME: "FREE", VERSION: "23.0.0.0.0", STATUS: "OPEN", HOST_NAME: "db1", STARTUP: "2026-11-01 08:00:00", UPTIME_DAYS: 6.1, CON_NAME: "FREEPDB1" };

  it("summarises instance, load, sessions and flags blocked sessions", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [INSTANCE] })
      .mockResolvedValueOnce({ rows: [{ TOTAL: 12, ACTIVE: 3, BLOCKED: 2, LONGEST_ACTIVE_S: 40 }] })
      .mockResolvedValueOnce({ rows: [{ WHAT: "Application", SESSIONS: 2 }, { WHAT: "CPU", SESSIONS: 1 }] })
      .mockResolvedValueOnce({ rows: [{ METRIC_NAME: "Average Active Sessions", VALUE: 3, METRIC_UNIT: "Active Sessions" }] })
      .mockResolvedValueOnce({ rows: [{ VALUE: 2 }] }); // V$OSSTAT NUM_CPUS
    const out = await run("db_overview");
    expect(out).toContain("Instance FREE (23.0.0.0.0, OPEN) on db1 — container FREEPDB1");
    expect(out).toContain("12 total, 3 active, 2 blocked");
    expect(out).toContain("Application");
    expect(out).toContain("2 session(s) are blocked → run the locks tool");
    expect(out).toContain("Average active sessions (3) exceed the CPU count (2)");
  });

  it("falls back to V$CON_SYSMETRIC and to the session sample when no metrics are visible", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [INSTANCE] })
      .mockResolvedValueOnce({ rows: [{ TOTAL: 0, ACTIVE: 0, BLOCKED: 0, LONGEST_ACTIVE_S: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })                                          // V$SYSMETRIC empty
      .mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"))  // V$CON_SYSMETRIC not granted
      .mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist")); // V$OSSTAT not granted
    const out = await run("db_overview");
    expect(sqlOf(4)).toContain("v$con_sysmetric");
    expect(out).toContain("Load metrics: not available in this container");
    expect(out).toContain("No active user sessions right now.");
    expect(out).toContain("nothing unusual");
  });

  it("flags long running calls and high host CPU", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [INSTANCE] })
      .mockResolvedValueOnce({ rows: [{ TOTAL: 1, ACTIVE: 1, BLOCKED: 0, LONGEST_ACTIVE_S: 900 }] })
      .mockResolvedValueOnce({ rows: [{ WHAT: "CPU", SESSIONS: 1 }] })
      .mockResolvedValueOnce({ rows: [{ METRIC_NAME: "Host CPU Utilization (%)", VALUE: 95, METRIC_UNIT: "%" }] })
      .mockResolvedValueOnce({ rows: [{ VALUE: 8 }] });
    const out = await run("db_overview");
    expect(out).toContain("running for 900 s");
    expect(out).toContain("Host CPU utilisation is 95%");
  });
});

describe("locks", () => {
  it("reports when nothing is blocked and points to the alert log for deadlocks", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [] });
    const out = await run("locks");
    expect(bindsOf(0)).toEqual({ n: 20 });
    expect(out).toMatch(/No blocked sessions/);
    expect(out).toContain("ORA-00060");
    expect(conn.execute).toHaveBeenCalledTimes(1);
  });

  it("shows waiters, root blockers, held locks, an idle-holder diagnosis and an unexecuted kill statement", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ SID: 58, SERIAL: 7, USERNAME: "APP", EVENT: "enq: TX - row lock contention", WAIT_S: 42, BLOCKER: 221, ROOT_BLOCKER: 221, SQL_ID: "5kqtcyq6s8thu", LOCKED_OBJECT: "APP.ORDERS", MODULE: "web" }] })
      .mockResolvedValueOnce({ rows: [{ SID: 221, SERIAL: 25578, USERNAME: "BATCH", STATUS: "INACTIVE", IDLE_S: 600, WAITERS: 1, PREV_SQL_ID: "cnd0n49dfh7xa", MACHINE: "app01", MODULE: "nightly-batch", PROGRAM: "job" }] })
      .mockResolvedValueOnce({ rows: [{ SID: 221, USERNAME: "BATCH", OBJECT_NAME: "APP.ORDERS", LOCK_MODE: "row exclusive" }] });
    const out = await run("locks", { limit: 5 });
    expect(bindsOf(0)).toEqual({ n: 5 });
    expect(out).toContain("APP.ORDERS");
    expect(out).toContain("row exclusive");
    expect(out).toContain("SID 221 is INACTIVE for 600 s");
    expect(out).toContain("(BATCH @ app01, module nightly-batch)");
    expect(out).toContain("ALTER SYSTEM KILL SESSION '221,25578' IMMEDIATE;");
    expect(out).toContain("NOT executed");
    // the tool itself only ever runs SELECTs
    for (let i = 0; i < conn.execute.mock.calls.length; i++) expect(sqlOf(i)).not.toMatch(/ALTER SYSTEM/);
  });
});

describe("alert_log, incidents, trace files", () => {
  it("alert_log binds the window and filters and lists oldest first with the trace file", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [
      { TS: "2026-11-07 10:02:00 +00:00", LVL: 1, PROBLEM_KEY: "ORA 600", TRACE_FILE: "FREE_ora_9.trc", MSG: "Errors in file /x/FREE_ora_9.trc:" },
      { TS: "2026-11-07 10:01:00 +00:00", LVL: 16, MSG: "earlier" },
    ] });
    const out = await run("alert_log", { minutes: 999999, errors_only: true, contains: "ORA-", limit: 500 });
    expect(bindsOf(0)).toEqual({ minutes: 43200, errors: 1, pattern: "ORA-", n: 200 });
    expect(sqlOf(0)).toContain("v$diag_alert_ext");
    expect(out.indexOf("earlier")).toBeLessThan(out.indexOf("Errors in file"));
    expect(out).toContain("FREE_ora_9.trc");
  });
  it("alert_log reports empty windows and adds the privilege hint on ORA-00942", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [] });
    expect(await run("alert_log", { errors_only: true })).toMatch(/No alert log entries in the last 60 minutes with error codes/);
    conn.execute.mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"));
    await expect(run("alert_log")).rejects.toThrow(/grant_perf_privileges/);
  });
  it("incidents lists recent incidents", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ INCIDENT_ID: 1234, CREATED: "2026-11-07", STATE: "open", ERROR: "ORA-00600", ERROR_ARG1: "kcbz_check", PROBLEM_KEY: "ORA 600 [kcbz_check]", COMPONENT: "RDBMS", FLOOD: 0 }] });
    const out = await run("incidents", { days: 3 });
    expect(bindsOf(0)).toEqual({ days: 3, n: 10 });
    expect(out).toContain("ORA 600 [kcbz_check]");
    conn.execute.mockResolvedValueOnce({ rows: [] });
    expect(await run("incidents")).toMatch(/No diagnostic incidents in the last 7 days/);
  });
  it("trace_files filters by name and age", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ TRACE_FILENAME: "FREE_pmon_1.trc", MODIFIED: "2026-11-07" }] });
    const out = await run("trace_files", { name_like: "pmon", minutes: 30, limit: 3 });
    expect(bindsOf(0)).toEqual({ minutes: 30, pattern: "pmon", n: 3 });
    expect(out).toContain("FREE_pmon_1.trc");
    conn.execute.mockResolvedValueOnce({ rows: [] });
    expect(await run("trace_files")).toBe("No matching trace files.");
    expect(bindsOf(1)).toEqual({ minutes: null, pattern: null, n: 20 });
  });
});

describe("trace_content", () => {
  it("reads the tail by default, reduces a path to the file name and binds everything", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [
      { RN: 499, PAYLOAD: "line 499\n", TOTAL: 500 }, { RN: 500, PAYLOAD: "line 500", TOTAL: 500 },
    ] });
    const out = await run("trace_content", { file: "/u01/app/diag/trace/FREE_ora_9.trc", lines: 2 });
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(bindsOf(0)).toEqual({ f: "FREE_ora_9.trc", pattern: null, ctx: 0, tail: 1, n: 2 });
    expect(sqlOf(0)).toContain("v$diag_trace_file_contents");
    expect(out).toContain("tail 2 of 500 lines");
    expect(out).toContain("treat as sensitive");
    expect(out).toContain("line 499\nline 500");
    expect(out).not.toContain("--");
  });
  it("reads the head and applies a text filter", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ RN: 7, PAYLOAD: "ORA-00600: internal error", TOTAL: 1 }] });
    const out = await run("trace_content", { file: "x.trc", position: "head", contains: "ORA-", lines: 50 });
    expect(bindsOf(0)).toEqual({ f: "x.trc", pattern: "ORA-", ctx: 0, tail: 0, n: 50 });
    expect(out).toContain('head 1 of 1 lines containing "ORA-"');
  });
  it("adds context around matches, separates distant blocks and clamps the context", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [
      { RN: 9, PAYLOAD: "before", TOTAL: 4 }, { RN: 10, PAYLOAD: "Deadlock graph:", TOTAL: 4 },
      { RN: 40, PAYLOAD: "second block", TOTAL: 4 }, { RN: 41, PAYLOAD: "Deadlock graph again", TOTAL: 4 },
    ] });
    const out = await run("trace_content", { file: "x.trc", contains: "Deadlock graph", context: 999 });
    expect(bindsOf(0)).toMatchObject({ pattern: "Deadlock graph", ctx: 50 });
    expect(out).toContain('containing "Deadlock graph" (±50 lines of context)');
    expect(out).toContain("Deadlock graph:\n--\nsecond block");
  });
  it("rejects unsafe file names and positions without touching the database", async () => {
    await expect(run("trace_content", { file: "x;drop table t" })).rejects.toThrow(/Invalid trace file name/);
    await expect(run("trace_content", { file: "" })).rejects.toThrow(/Invalid trace file name/);
    await expect(run("trace_content", { file: "x.trc", position: "middle" })).rejects.toThrow(/Invalid position/);
    expect(conn.execute).not.toHaveBeenCalled();
  });
  it("explains empty results and cuts very long output", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [] });
    expect(await run("trace_content", { file: "gone.trc" })).toMatch(/No lines found in trace file gone.trc/);
    conn.execute.mockResolvedValueOnce({ rows: [{ RN: 1, PAYLOAD: "x".repeat(150_000), TOTAL: 1 }] });
    const out = await run("trace_content", { file: "big.trc" });
    expect(out).toContain("output cut to 100000 characters");
    expect(out.length).toBeLessThan(101_000);
  });
});

describe("table_stats", () => {
  it("reports missing tables", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ O: "HR" }] }).mockResolvedValueOnce({ rows: [] });
    expect(await run("table_stats", { table: "nope" })).toBe('Table "HR.NOPE" not found.');
  });
  it("warns about stale statistics and lists indexes and columns", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ O: "HR" }] })
      .mockResolvedValueOnce({ rows: [{ NUM_ROWS: 100, LAST_ANALYZED: "2026-01-01 00:00:00", STALE_STATS: "YES" }] })
      .mockResolvedValueOnce({ rows: [{ INDEX_NAME: "EMP_PK", UNIQUENESS: "UNIQUE", COLUMNS: "ID" }] })
      .mockResolvedValueOnce({ rows: [{ COLUMN_NAME: "ID", NUM_DISTINCT: 100, HISTOGRAM: "NONE" }] });
    const out = await run("table_stats", { table: "emp", schema: "hr" });
    expect(bindsOf(0)).toEqual({ o: "HR" });
    expect(bindsOf(1)).toEqual({ owner: "HR", tab: "EMP" });
    expect(out).toContain("Statistics are stale");
    expect(out).toContain("EMP_PK");
    expect(out).toContain("Indexes (1):");
  });
  it("warns when statistics are missing", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ O: "HR" }] })
      .mockResolvedValueOnce({ rows: [{ NUM_ROWS: null, LAST_ANALYZED: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await run("table_stats", { table: "emp" })).toContain("No optimizer statistics");
  });
});

describe("licensed tools", () => {
  it("ash_top groups by the whitelisted dimension and computes AAS", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ WAIT_CLASS: "CPU", EVENT: "ON CPU", SAMPLES: 90, PCT: 75 }] })
      .mockResolvedValueOnce({ rows: [{ SAMPLES: 120 }] });
    const out = await run("ash_top", { minutes: 1, group_by: "event" });
    expect(sqlOf(0)).toContain("FROM v$active_session_history");
    expect(out).toContain("120 samples");
    expect(out).toContain("average active sessions 2.00");
    await expect(run("ash_top", { group_by: "x" })).rejects.toThrow(/Invalid group_by/);
  });
  it("ash_top without samples notes a disabled pack in the database", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ VALUE: "NONE" }] });
    expect(await run("ash_top")).toMatch(/CONTROL_MANAGEMENT_PACK_ACCESS = NONE/);
  });
  it("awr_top_events computes deltas between the first and last snapshot", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ DBID: 1, INSTANCE_NUMBER: 1, B: 10, E: 20, STARTUPS: 1, T_BEGIN: "a", T_END: "b" }] })
      .mockResolvedValueOnce({ rows: [{ STAT_NAME: "DB time", SECONDS: 100 }, { STAT_NAME: "DB CPU", SECONDS: 40 }] })
      .mockResolvedValueOnce({ rows: [{ EVENT_NAME: "log file sync", WAIT_CLASS: "Commit", WAITS: 5, TIME_S: 50, AVG_MS: 10 }] });
    const out = await run("awr_top_events", { hours: 2 });
    expect(bindsOf(1)).toEqual({ dbid: 1, inst: 1, b: 10, e: 20 });
    expect(out).toContain("DB time 100s, DB CPU 40s");
    const lines = out.split("\n");
    expect(lines.findIndex(l => l.endsWith("log file sync"))).toBeLessThan(lines.findIndex(l => /CPU\s+DB CPU$/.test(l)));
    expect(out).toMatch(/50\s+50/); // 50s = 50 % of DB time
  });
  it("awr_top_events falls back to AWR_ROOT_* views in a PDB without PDB snapshots", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ DBID: 7, INSTANCE_NUMBER: 1, B: 1, E: 2, STARTUPS: 1, T_BEGIN: "a", T_END: "b" }] })
      .mockResolvedValueOnce({ rows: [{ STAT_NAME: "DB time", SECONDS: 10 }, { STAT_NAME: "DB CPU", SECONDS: 10 }] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await run("awr_top_events");
    expect(sqlOf(0)).toContain("FROM dba_hist_snapshot");
    expect(sqlOf(1)).toContain("FROM awr_root_snapshot");
    expect(sqlOf(3)).toContain("awr_root_system_event");
    expect(out).toContain("CDB root AWR data");
  });
  it("awr_top_events prefers a dbid with two snapshots over the PDB's single one", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [
        { DBID: 300, OWN: 1, INSTANCE_NUMBER: 1, B: 1, E: 1, STARTUPS: 1 },
        { DBID: 100, OWN: 0, INSTANCE_NUMBER: 1, B: 1, E: 3, STARTUPS: 1, T_BEGIN: "a", T_END: "b" },
      ] })
      .mockResolvedValueOnce({ rows: [{ STAT_NAME: "DB time", SECONDS: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await run("awr_top_events");
    expect(bindsOf(1)).toMatchObject({ dbid: 100, b: 1, e: 3 });
    expect(out).toContain("(dbid 100)");
    expect(out).toContain("CDB root AWR data");
    expect(out).not.toContain("dbid 300");
  });
  it("awr_top_events reports statistics that are not visible from the container", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ DBID: 100, OWN: 0, INSTANCE_NUMBER: 1, B: 1, E: 3, STARTUPS: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await run("awr_top_events")).toMatch(/not visible from the current container/);
  });
  it("awr_top_events ignores missing AWR_ROOT_* views (pre-12.2)", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("ORA-00942"))
      .mockResolvedValueOnce({ rows: [] });
    expect(await run("awr_top_events")).toMatch(/No AWR snapshots/);
  });
  it("awr_top_events refuses windows with restarts", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ DBID: 1, INSTANCE_NUMBER: 1, B: 1, E: 5, STARTUPS: 2 }] });
    expect(await run("awr_top_events")).toMatch(/restarted/);
  });
  it("sql_monitor returns the report for a sql_id and lists executions otherwise", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ REPORT: "SQL Monitoring Report\n\nGlobal Information\n..." }] });
    expect(await run("sql_monitor", { sql_id: "0abcd1234efgh" })).toMatch(/^SQL Monitoring Report/);
    expect(conn.execute.mock.calls[0][2]).toMatchObject({ fetchInfo: { REPORT: { type: 2001 } } });
    conn.execute.mockResolvedValueOnce({ rows: [{ SQL_ID: "0abcd1234efgh", STATUS: "DONE" }] });
    expect(await run("sql_monitor")).toContain("Recent monitored executions");
  });
  it("sql_monitor treats a title-only report as missing data or privileges", async () => {
    conn.execute
      .mockResolvedValueOnce({ rows: [{ REPORT: "SQL Monitoring Report" }] })
      .mockResolvedValueOnce({ rows: [{ VALUE: "DIAGNOSTIC+TUNING" }] });
    expect(await run("sql_monitor", { sql_id: "0abcd1234efgh" })).toMatch(/No SQL Monitor data .*V\$SQL_MONITOR/);
  });
  it("sql_plan turns the DBMS_XPLAN privilege message into an error with hint", async () => {
    conn.execute.mockResolvedValueOnce({ rows: [{ LINE: "User has no SELECT privilege on V$SQL" }] });
    await expect(run("sql_plan", { sql_id: "0abcd1234efgh" })).rejects.toThrow(/no SELECT privilege on V\$SQL[\s\S]*grant_perf_privileges|SELECT_CATALOG_ROLE/);
  });
});

describe("formatTable / firstKeyword", () => {
  it("aligns columns, right-aligns numbers and never cuts the last column", () => {
    const out = formatTable(["NAME", "N", "TEXT"], [["a", 1, "x".repeat(60)], ["long-name", 100, "y"]], 5);
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME     N  TEXT");
    expect(lines[2]).toBe("a        1  " + "x".repeat(60));
    expect(lines[3]).toBe("long…  100  y");
  });
  it("firstKeyword skips comments and parentheses", () => {
    expect(firstKeyword("/* x */ -- y\n (select 1 from dual)")).toBe("SELECT");
    expect(firstKeyword("   ")).toBe("");
  });
});
