/**
 * Performance analysis tools.
 *
 * Unlicensed (feature "perf", ORA_PERF_TOOLS, default on):
 *   explain_plan, sql_plan, top_sql, session_activity, table_stats
 * Oracle Diagnostics Pack (feature "diagnostics", ORA_DIAGNOSTICS_PACK / token diagnostics_pack, default off):
 *   ash_top, awr_top_events
 * Oracle Tuning Pack (feature "tuning", ORA_TUNING_PACK / token tuning_pack, default off):
 *   sql_monitor
 *
 * Licensed tools are not listed and refuse to run unless the feature is enabled, so
 * clients cannot touch pack-licensed views (V$ACTIVE_SESSION_HISTORY, DBA_HIST_*,
 * V$SQL_MONITOR, DBMS_SQLTUNE) by accident. The generic query tool is not restricted.
 */
import oracledb from "oracledb";
import { randomUUID } from "node:crypto";
import { formatTable } from "./format.js";
import { firstKeyword, normalizeSql, toIdentifier, type PerfFeatures } from "./oracle.js";

/** Marker in every internal statement; top_sql filters these out. */
export const SQL_TAG = "/* oracle-mcp-server */";
/** ACTION prefix while a performance tool runs; recursive SQL (e.g. DBMS_XPLAN internals)
 *  inherits it, so top_sql can exclude the tools' own statements. MODULE stays the server name. */
export const PERF_ACTION_PREFIX = "mcp-perf:";

type Feature = keyof PerfFeatures;

interface PerfTool {
  name: string;
  feature: Feature;
  description: string;
  inputSchema: Record<string, unknown>;
}

const LIMIT = { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of rows (default 10)" };

export const PERF_TOOLS: PerfTool[] = [
  {
    name: "explain_plan",
    feature: "perf",
    description: "Show the optimizer execution plan (EXPLAIN PLAN + DBMS_XPLAN.DISPLAY) of a SELECT, WITH, INSERT, "
      + "UPDATE, DELETE or MERGE statement without executing it.",
    inputSchema: {
      type: "object",
      properties: {
        sql:    { type: "string", description: "Statement to explain; bind variables (:1, :name) may stay unbound" },
        format: { type: "string", description: "DBMS_XPLAN format, e.g. TYPICAL (default), BASIC, ALL, ADVANCED, TYPICAL +OUTLINE" },
      },
      required: ["sql"],
    },
  },
  {
    name: "sql_plan",
    feature: "perf",
    description: "Show the actual execution plan of a cached cursor (DBMS_XPLAN.DISPLAY_CURSOR) by sql_id, e.g. from "
      + "top_sql or session_activity. Use format 'ALLSTATS LAST' for row source statistics (requires the "
      + "GATHER_PLAN_STATISTICS hint or STATISTICS_LEVEL=ALL). Needs SELECT on V$SQL, V$SQL_PLAN, V$SQL_PLAN_STATISTICS_ALL.",
    inputSchema: {
      type: "object",
      properties: {
        sql_id:       { type: "string", description: "13-character SQL_ID" },
        child_number: { type: "integer", description: "Child cursor number (default: all children)" },
        format:       { type: "string", description: "DBMS_XPLAN format (default: TYPICAL +PEEKED_BINDS)" },
      },
      required: ["sql_id"],
    },
  },
  {
    name: "top_sql",
    feature: "perf",
    description: "Top SQL statements from the shared pool (V$SQLAREA) by elapsed time, CPU, buffer gets, disk reads "
      + "or executions, with per-execution averages and sql_id.",
    inputSchema: {
      type: "object",
      properties: {
        order_by:       { type: "string", enum: ["elapsed", "cpu", "buffer_gets", "disk_reads", "executions", "elapsed_per_exec"], description: "Sort metric (default elapsed)" },
        schema:         { type: "string", description: "Only statements parsed by this schema" },
        sql_text_like:  { type: "string", description: "Case-insensitive substring filter on the SQL text" },
        include_system: { type: "boolean", description: "Include statements parsed as SYS (default false)" },
        limit:          LIMIT,
      },
    },
  },
  {
    name: "session_activity",
    feature: "perf",
    description: "Current user sessions (V$SESSION): status, sql_id, wait event, blocking session, plus the top "
      + "non-idle wait events since instance startup (V$SYSTEM_EVENT).",
    inputSchema: {
      type: "object",
      properties: {
        include_idle: { type: "boolean", description: "Include INACTIVE sessions (default false)" },
        username:     { type: "string", description: "Only sessions of this user" },
        limit:        { ...LIMIT, description: "Maximum number of sessions (default 50)" },
      },
    },
  },
  {
    name: "table_stats",
    feature: "perf",
    description: "Optimizer statistics of a table: rows, blocks, staleness, lock state, indexes (columns, "
      + "clustering factor, status) and column statistics (distinct values, nulls, histograms).",
    inputSchema: {
      type: "object",
      properties: {
        table:  { type: "string", description: "Table name. Unquoted names are upper-cased." },
        schema: { type: "string", description: "Schema (owner), default: current schema" },
      },
      required: ["table"],
    },
  },
  {
    name: "ash_top",
    feature: "diagnostics",
    description: "Active Session History (V$ACTIVE_SESSION_HISTORY) of the last minutes grouped by sql_id, event, "
      + "wait class, session or module. One sample ≈ one second of DB time. Requires the Oracle Diagnostics Pack licence.",
    inputSchema: {
      type: "object",
      properties: {
        minutes:  { type: "integer", minimum: 1, maximum: 1440, description: "Time window in minutes (default 15)" },
        group_by: { type: "string", enum: ["sql_id", "event", "wait_class", "session", "module"], description: "Grouping (default sql_id)" },
        limit:    LIMIT,
      },
    },
  },
  {
    name: "awr_top_events",
    feature: "diagnostics",
    description: "Top wait events, DB time and DB CPU between the first and last AWR snapshot of the last hours "
      + "(DBA_HIST_*). Requires the Oracle Diagnostics Pack licence.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", minimum: 1, maximum: 720, description: "Time window in hours (default 24)" },
        limit: LIMIT,
      },
    },
  },
  {
    name: "sql_monitor",
    feature: "tuning",
    description: "Real-Time SQL Monitoring: without sql_id lists recent monitored executions (V$SQL_MONITOR); with "
      + "sql_id returns the text report (DBMS_SQLTUNE.REPORT_SQL_MONITOR). Requires the Oracle Tuning Pack licence.",
    inputSchema: {
      type: "object",
      properties: {
        sql_id: { type: "string", description: "13-character SQL_ID; omit to list monitored executions" },
        limit:  LIMIT,
      },
    },
  },
];

export const PERF_TOOL_NAMES = new Set(PERF_TOOLS.map(t => t.name));

const FEATURE_HINT: Record<Feature, string> = {
  perf:        "performance tools are disabled (ORA_PERF_TOOLS=false)",
  diagnostics: "requires the Oracle Diagnostics Pack licence — enable with ORA_DIAGNOSTICS_PACK=true or the token's diagnostics_pack",
  tuning:      "requires the Oracle Tuning Pack licence — enable with ORA_TUNING_PACK=true or the token's tuning_pack",
};

/** Tool definitions visible for the given feature set. */
export function perfToolList(features: PerfFeatures): Omit<PerfTool, "feature">[] {
  return PERF_TOOLS.filter(t => features[t.feature]).map(({ feature: _f, ...t }) => t);
}

// ── helpers ───────────────────────────────────────────────────────────────────
type Args = Record<string, unknown>;
type Row = Record<string, unknown>;

function limitArg(v: unknown, def: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : def;
}

function sqlIdArg(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^[0-9a-z]{13}$/.test(s)) throw new Error(`Invalid sql_id "${s}" (expected 13 characters 0-9, a-z)`);
  return s;
}

function formatArg(v: unknown, def: string): string {
  const s = String(v ?? "").trim() || def;
  if (!/^[A-Za-z0-9_ +\-,()]+$/.test(s)) throw new Error(`Invalid DBMS_XPLAN format "${s}"`);
  return s;
}

async function rows(conn: oracledb.Connection, sql: string, binds: oracledb.BindParameters = {}): Promise<Row[]> {
  const r = await conn.execute<Row>(`${SQL_TAG} ${sql}`, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows ?? [];
}

function table(data: Row[], cols: [string, string][]): string {
  return formatTable(cols.map(c => c[1]), data.map(r => cols.map(c => r[c[0]])));
}

async function currentSchema(conn: oracledb.Connection, schema: unknown): Promise<string> {
  const r = await rows(conn, "SELECT NVL(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AS o FROM dual",
    { o: toIdentifier(schema as string | undefined) });
  return String(r[0]?.O ?? "");
}

/** Hint when the database itself does not enable the pack (CONTROL_MANAGEMENT_PACK_ACCESS). */
async function packAccessNote(conn: oracledb.Connection, needed: "DIAGNOSTIC" | "TUNING"): Promise<string> {
  try {
    const r = await rows(conn, "SELECT value FROM v$parameter WHERE name = 'control_management_pack_access'");
    const v = String(r[0]?.VALUE ?? "");
    if (v && !v.toUpperCase().includes(needed)) {
      return `\n\nNote: CONTROL_MANAGEMENT_PACK_ACCESS = ${v} — the database does not collect ${needed.toLowerCase()} pack data.`;
    }
  } catch { /* no access to V$PARAMETER */ }
  return "";
}

const PRIV_HINT = "\nHint: performance tools need read access to dynamic performance views — run "
  + "scripts/sql/grant_perf_privileges.sql as SYS (or GRANT SELECT_CATALOG_ROLE to the database user); "
  + "see docs/performance.md.";

// ── tool implementations ──────────────────────────────────────────────────────
async function explainPlan(conn: oracledb.Connection, args: Args): Promise<string> {
  const sql = normalizeSql(String(args.sql ?? ""));
  const kw = firstKeyword(sql);
  if (!["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(kw)) {
    throw new Error("explain_plan supports SELECT, WITH, INSERT, UPDATE, DELETE and MERGE statements");
  }
  const fmt = formatArg(args.format, "TYPICAL");
  // STATEMENT_ID must be a literal; it is generated here, never taken from input
  const id = "MCP" + randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase();
  try {
    // via EXECUTE IMMEDIATE so bind placeholders (:1, :name) need no values
    await conn.execute("BEGIN EXECUTE IMMEDIATE :stmt; END;", { stmt: `EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}` });
    const r = await rows(conn, "SELECT plan_table_output AS line FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, :fmt))",
      { id, fmt });
    return r.map(x => x.LINE ?? "").join("\n");
  } finally {
    await conn.rollback().catch(() => {});
  }
}

async function sqlPlan(conn: oracledb.Connection, args: Args): Promise<string> {
  const sqlId = sqlIdArg(args.sql_id);
  const child = args.child_number === undefined || args.child_number === null ? null : Math.floor(Number(args.child_number));
  const fmt = formatArg(args.format, "TYPICAL +PEEKED_BINDS");
  const r = await rows(conn, "SELECT plan_table_output AS line FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:id, :child, :fmt))",
    { id: sqlId, child, fmt });
  const out = r.map(x => x.LINE ?? "").join("\n");
  // DBMS_XPLAN reports missing privileges as plan text instead of raising an error
  const denied = out.match(/User has no SELECT privilege on \S+/);
  if (denied) throw new Error(denied[0] + PRIV_HINT);
  return out;
}

const TOP_SQL_ORDER: Record<string, string> = {
  elapsed:          "elapsed_time",
  cpu:              "cpu_time",
  buffer_gets:      "buffer_gets",
  disk_reads:       "disk_reads",
  executions:       "executions",
  elapsed_per_exec: "elapsed_time / NULLIF(executions, 0)",
};

async function topSql(conn: oracledb.Connection, args: Args): Promise<string> {
  const orderKey = String(args.order_by ?? "elapsed");
  const order = TOP_SQL_ORDER[orderKey];
  if (!order) throw new Error(`Invalid order_by "${orderKey}" (${Object.keys(TOP_SQL_ORDER).join(", ")})`);
  const n = limitArg(args.limit, 10);
  const data = await rows(conn,
    `SELECT * FROM (
       SELECT sql_id, plan_hash_value, parsing_schema_name AS schema_name, executions,
              ROUND(elapsed_time / 1e6, 2) AS elapsed_s,
              ROUND(cpu_time / 1e6, 2) AS cpu_s,
              ROUND(elapsed_time / NULLIF(executions, 0) / 1e3, 2) AS ela_ms_exec,
              buffer_gets, disk_reads, rows_processed,
              TO_CHAR(last_active_time, 'YYYY-MM-DD HH24:MI:SS') AS last_active,
              SUBSTR(REGEXP_REPLACE(sql_text, '\\s+', ' '), 1, 200) AS sql_text
       FROM v$sqlarea
       WHERE sql_text NOT LIKE '%oracle-mcp-server%'
         AND NVL(action, '-') NOT LIKE 'mcp-perf:%'
         AND (:inc_sys = 1 OR parsing_schema_name <> 'SYS')
         AND (:schema_name IS NULL OR parsing_schema_name = :schema_name)
         AND (:pattern IS NULL OR UPPER(sql_text) LIKE '%' || UPPER(:pattern) || '%')
       ORDER BY ${order} DESC NULLS LAST)
     WHERE ROWNUM <= :n`,
    {
      inc_sys: args.include_system ? 1 : 0,
      schema_name: toIdentifier(args.schema as string | undefined),
      pattern: args.sql_text_like ? String(args.sql_text_like) : null,
      n,
    });
  if (!data.length) return "No matching statements in the shared pool.";
  return `Top ${data.length} SQL by ${orderKey} (V$SQLAREA, cumulative since load):\n\n` + table(data, [
    ["SQL_ID", "SQL_ID"], ["PLAN_HASH_VALUE", "PLAN_HASH"], ["SCHEMA_NAME", "SCHEMA"], ["EXECUTIONS", "EXECS"],
    ["ELAPSED_S", "ELAPSED_S"], ["CPU_S", "CPU_S"], ["ELA_MS_EXEC", "MS/EXEC"], ["BUFFER_GETS", "GETS"],
    ["DISK_READS", "READS"], ["ROWS_PROCESSED", "ROWS"], ["LAST_ACTIVE", "LAST_ACTIVE"], ["SQL_TEXT", "SQL_TEXT"],
  ]);
}

async function sessionActivity(conn: oracledb.Connection, args: Args): Promise<string> {
  const n = limitArg(args.limit, 50);
  const sessions = await rows(conn,
    `SELECT * FROM (
       SELECT s.sid, s.serial# AS serial, s.username, s.status, s.sql_id,
              DECODE(s.state, 'WAITING', s.event, 'ON CPU') AS event,
              DECODE(s.state, 'WAITING', s.wait_class, 'CPU') AS wait_class,
              ROUND(s.wait_time_micro / 1e6, 1) AS wait_s, s.last_call_et, s.blocking_session,
              s.machine, s.program, s.module
       FROM v$session s
       WHERE s.type = 'USER'
         AND s.sid <> TO_NUMBER(SYS_CONTEXT('USERENV', 'SID'))
         AND (:idle = 1 OR s.status = 'ACTIVE')
         AND (:username IS NULL OR s.username = :username)
       ORDER BY CASE WHEN s.blocking_session IS NOT NULL THEN 0 ELSE 1 END, s.status, s.last_call_et DESC)
     WHERE ROWNUM <= :n`,
    { idle: args.include_idle ? 1 : 0, username: toIdentifier(args.username as string | undefined), n });
  const waits = await rows(conn,
    `SELECT * FROM (
       SELECT event, wait_class, total_waits, ROUND(time_waited_micro / 1e6, 1) AS time_s,
              ROUND(time_waited_micro / NULLIF(total_waits, 0) / 1e3, 2) AS avg_ms
       FROM v$system_event
       WHERE wait_class <> 'Idle'
       ORDER BY time_waited_micro DESC)
     WHERE ROWNUM <= 10`);
  const blocked = sessions.filter(s => s.BLOCKING_SESSION !== null && s.BLOCKING_SESSION !== undefined).length;
  const parts = [
    `Sessions (${sessions.length}${args.include_idle ? "" : " active"}, ${blocked} blocked):`,
    sessions.length ? table(sessions, [
      ["SID", "SID"], ["SERIAL", "SERIAL#"], ["USERNAME", "USER"], ["STATUS", "STATUS"], ["SQL_ID", "SQL_ID"],
      ["EVENT", "EVENT"], ["WAIT_CLASS", "WAIT_CLASS"], ["WAIT_S", "WAIT_S"], ["LAST_CALL_ET", "CALL_S"],
      ["BLOCKING_SESSION", "BLOCKER"], ["MACHINE", "MACHINE"], ["MODULE", "MODULE"], ["PROGRAM", "PROGRAM"],
    ]) : "(none)",
    "",
    "Top non-idle wait events since startup (V$SYSTEM_EVENT):",
    waits.length ? table(waits, [
      ["TIME_S", "TIME_S"], ["TOTAL_WAITS", "WAITS"], ["AVG_MS", "AVG_MS"], ["WAIT_CLASS", "WAIT_CLASS"], ["EVENT", "EVENT"],
    ]) : "(none)",
  ];
  return parts.join("\n");
}

async function tableStats(conn: oracledb.Connection, args: Args): Promise<string> {
  if (!args.table) throw new Error('"table" is required');
  const owner = await currentSchema(conn, args.schema);
  const tab = toIdentifier(args.table as string)!;
  const t = await rows(conn,
    `SELECT t.num_rows, t.blocks, t.empty_blocks, t.avg_row_len, t.partitioned, TRIM(t.degree) AS degree,
            t.compression, t.temporary, TO_CHAR(t.last_analyzed, 'YYYY-MM-DD HH24:MI:SS') AS last_analyzed,
            s.stale_stats, s.stattype_locked, s.sample_size
     FROM all_tables t
     LEFT JOIN all_tab_statistics s
       ON s.owner = t.owner AND s.table_name = t.table_name AND s.object_type = 'TABLE'
     WHERE t.owner = :owner AND t.table_name = :tab`, { owner, tab });
  if (!t.length) return `Table "${owner}.${tab}" not found.`;
  const r = t[0];
  const v = (x: unknown) => (x === null || x === undefined || x === "" ? "-" : String(x));
  const head = [
    `Table: ${owner}.${tab}`,
    `  Rows          : ${v(r.NUM_ROWS)}   Blocks: ${v(r.BLOCKS)}   Avg row length: ${v(r.AVG_ROW_LEN)}   Sample size: ${v(r.SAMPLE_SIZE)}`,
    `  Last analyzed : ${v(r.LAST_ANALYZED)}   Stale: ${v(r.STALE_STATS)}   Locked: ${v(r.STATTYPE_LOCKED)}`,
    `  Partitioned   : ${v(r.PARTITIONED)}   Degree: ${v(r.DEGREE)}   Compression: ${v(r.COMPRESSION)}   Temporary: ${v(r.TEMPORARY)}`,
  ];
  if (!r.LAST_ANALYZED) head.push("  ⚠️  No optimizer statistics — consider DBMS_STATS.GATHER_TABLE_STATS.");
  else if (r.STALE_STATS === "YES") head.push("  ⚠️  Statistics are stale.");

  const idx = await rows(conn,
    `SELECT i.index_name, i.index_type, i.uniqueness, i.status, i.visibility, i.blevel, i.leaf_blocks,
            i.distinct_keys, i.clustering_factor, TO_CHAR(i.last_analyzed, 'YYYY-MM-DD HH24:MI') AS last_analyzed,
            (SELECT LISTAGG(c.column_name, ', ') WITHIN GROUP (ORDER BY c.column_position)
               FROM all_ind_columns c WHERE c.index_owner = i.owner AND c.index_name = i.index_name) AS columns
     FROM all_indexes i
     WHERE i.table_owner = :owner AND i.table_name = :tab
     ORDER BY i.index_name`, { owner, tab });
  const cols = await rows(conn,
    `SELECT column_name, data_type, num_distinct, num_nulls, density, histogram, num_buckets,
            TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI') AS last_analyzed
     FROM all_tab_columns
     WHERE owner = :owner AND table_name = :tab
     ORDER BY column_id`, { owner, tab });
  return [
    ...head,
    "",
    `Indexes (${idx.length}):`,
    idx.length ? table(idx, [
      ["INDEX_NAME", "INDEX"], ["INDEX_TYPE", "TYPE"], ["UNIQUENESS", "UNIQUE"], ["STATUS", "STATUS"],
      ["VISIBILITY", "VISIBLE"], ["BLEVEL", "BLEVEL"], ["LEAF_BLOCKS", "LEAVES"], ["DISTINCT_KEYS", "KEYS"],
      ["CLUSTERING_FACTOR", "CLUSTERING"], ["LAST_ANALYZED", "ANALYZED"], ["COLUMNS", "COLUMNS"],
    ]) : "(none)",
    "",
    "Column statistics:",
    table(cols, [
      ["COLUMN_NAME", "COLUMN"], ["DATA_TYPE", "TYPE"], ["NUM_DISTINCT", "DISTINCT"], ["NUM_NULLS", "NULLS"],
      ["DENSITY", "DENSITY"], ["NUM_BUCKETS", "BUCKETS"], ["LAST_ANALYZED", "ANALYZED"], ["HISTOGRAM", "HISTOGRAM"],
    ]),
  ].join("\n");
}

const ASH_GROUPS: Record<string, { select: string; group: string; cols: [string, string][] }> = {
  sql_id: {
    select: "NVL(sql_id, '-') AS sql_id, MAX(sql_opname) AS op",
    group:  "NVL(sql_id, '-')",
    cols:   [["SQL_ID", "SQL_ID"], ["OP", "OPERATION"]],
  },
  event: {
    select: "DECODE(session_state, 'ON CPU', 'ON CPU', event) AS event, DECODE(session_state, 'ON CPU', 'CPU', wait_class) AS wait_class",
    group:  "DECODE(session_state, 'ON CPU', 'ON CPU', event), DECODE(session_state, 'ON CPU', 'CPU', wait_class)",
    cols:   [["WAIT_CLASS", "WAIT_CLASS"], ["EVENT", "EVENT"]],
  },
  wait_class: {
    select: "DECODE(session_state, 'ON CPU', 'CPU', wait_class) AS wait_class",
    group:  "DECODE(session_state, 'ON CPU', 'CPU', wait_class)",
    cols:   [["WAIT_CLASS", "WAIT_CLASS"]],
  },
  session: {
    select: "session_id AS sid, session_serial# AS serial, (SELECT u.username FROM all_users u WHERE u.user_id = h.user_id) AS username",
    group:  "session_id, session_serial#, user_id",
    cols:   [["SID", "SID"], ["SERIAL", "SERIAL#"], ["USERNAME", "USER"]],
  },
  module: {
    select: "NVL(module, '-') AS module, NVL(program, '-') AS program",
    group:  "NVL(module, '-'), NVL(program, '-')",
    cols:   [["MODULE", "MODULE"], ["PROGRAM", "PROGRAM"]],
  },
};

async function ashTop(conn: oracledb.Connection, args: Args): Promise<string> {
  const minutes = Math.min(Math.max(Math.floor(Number(args.minutes ?? 15)) || 15, 1), 1440);
  const groupKey = String(args.group_by ?? "sql_id");
  const g = ASH_GROUPS[groupKey];
  if (!g) throw new Error(`Invalid group_by "${groupKey}" (${Object.keys(ASH_GROUPS).join(", ")})`);
  const n = limitArg(args.limit, 10);
  const data = await rows(conn,
    `SELECT * FROM (
       SELECT ${g.select}, COUNT(*) AS samples, ROUND(100 * RATIO_TO_REPORT(COUNT(*)) OVER (), 1) AS pct
       FROM v$active_session_history h
       WHERE sample_time > CAST(SYSTIMESTAMP AS TIMESTAMP) - NUMTODSINTERVAL(:minutes, 'MINUTE')
       GROUP BY ${g.group}
       ORDER BY COUNT(*) DESC)
     WHERE ROWNUM <= :n`, { minutes, n });
  if (!data.length) {
    return `No ASH samples in the last ${minutes} minutes.` + await packAccessNote(conn, "DIAGNOSTIC");
  }
  const total = await rows(conn,
    `SELECT COUNT(*) AS samples FROM v$active_session_history
     WHERE sample_time > CAST(SYSTIMESTAMP AS TIMESTAMP) - NUMTODSINTERVAL(:minutes, 'MINUTE')`, { minutes });
  const samples = Number(total[0]?.SAMPLES ?? 0);
  const aas = (samples / (minutes * 60)).toFixed(2);
  return `ASH last ${minutes} min by ${groupKey}: ${samples} samples ≈ ${samples}s DB time, average active sessions ${aas}\n\n`
    + table(data, [["SAMPLES", "SAMPLES"], ["PCT", "PCT"], ...g.cols]);
}

/**
 * AWR views: DBA_HIST_* (current container) or, in a PDB without PDB-level
 * snapshots (AWR_PDB_AUTOFLUSH_ENABLED=false), the CDB root data via AWR_ROOT_*.
 */
const AWR_SOURCES = [
  { prefix: "dba_hist", label: "" },
  { prefix: "awr_root", label: " – CDB root AWR data (AWR_ROOT_*)" },
] as const;

/**
 * Snapshot range per instance of one dbid. In a PDB, DBA_HIST_* contains both PDB-level
 * snapshots (dbid = CON_DBID) and CDB root snapshots; the container's own dbid is
 * preferred when it has at least two snapshots in the window, otherwise any dbid that has.
 */
async function awrSnapshots(conn: oracledb.Connection, prefix: string, hours: number): Promise<Row[]> {
  // begin/end_interval_time are TIMESTAMPs in server time: compare without time zone
  const all = await rows(conn,
    `SELECT dbid, instance_number, MIN(snap_id) AS b, MAX(snap_id) AS e,
            CASE WHEN dbid = TO_NUMBER(SYS_CONTEXT('USERENV', 'CON_DBID')) THEN 1 ELSE 0 END AS own,
            COUNT(DISTINCT startup_time) AS startups,
            TO_CHAR(MIN(begin_interval_time), 'YYYY-MM-DD HH24:MI') AS t_begin,
            TO_CHAR(MAX(end_interval_time), 'YYYY-MM-DD HH24:MI') AS t_end
     FROM ${prefix}_snapshot
     WHERE end_interval_time > CAST(SYSTIMESTAMP AS TIMESTAMP) - NUMTODSINTERVAL(:hours, 'HOUR')
     GROUP BY dbid, instance_number
     ORDER BY own DESC, dbid, instance_number`, { hours });
  const dbids = [...new Set(all.map(r => r.DBID))];
  const usable = dbids.find(id => all.some(r => r.DBID === id && r.B !== r.E)) ?? dbids[0];
  return all.filter(r => r.DBID === usable);
}

async function awrTopEvents(conn: oracledb.Connection, args: Args): Promise<string> {
  const hours = Math.min(Math.max(Number(args.hours ?? 24) || 24, 1), 720);
  const n = limitArg(args.limit, 10);
  let snaps: Row[] = [];
  let source: (typeof AWR_SOURCES)[number] = AWR_SOURCES[0];
  for (const src of AWR_SOURCES) {
    try {
      snaps = await awrSnapshots(conn, src.prefix, hours);
    } catch (err) {
      // AWR_ROOT_* only exists in 12.2+ PDBs
      if (src.prefix === "dba_hist") throw err;
      break;
    }
    source = src;
    if (snaps.length) break;
  }
  if (!snaps.length) return `No AWR snapshots in the last ${hours} hours.` + await packAccessNote(conn, "DIAGNOSTIC");
  const p = source.prefix;
  const out: string[] = [];
  for (const s of snaps) {
    const scope = source.label || (Number(s.OWN) === 1 ? "" : " – CDB root AWR data");
    const label = `Instance ${s.INSTANCE_NUMBER} (dbid ${s.DBID}), snapshots ${s.B}–${s.E} (${s.T_BEGIN} – ${s.T_END})${scope}`;
    if (s.B === s.E) { out.push(`${label}: only one snapshot in the window.`); continue; }
    if (Number(s.STARTUPS) > 1) { out.push(`${label}: instance restarted within the window — use a shorter window.`); continue; }
    const binds = { dbid: s.DBID as number, inst: s.INSTANCE_NUMBER as number, b: s.B as number, e: s.E as number };
    const tm = await rows(conn,
      `SELECT e.stat_name, ROUND((e.value - b.value) / 1e6, 1) AS seconds
       FROM ${p}_sys_time_model b
       JOIN ${p}_sys_time_model e
         ON e.dbid = b.dbid AND e.instance_number = b.instance_number AND e.stat_id = b.stat_id AND e.snap_id = :e
       WHERE b.dbid = :dbid AND b.instance_number = :inst AND b.snap_id = :b
         AND b.stat_name IN ('DB time', 'DB CPU')`, binds);
    if (!tm.length) {
      out.push(`${label}: statistics of this dbid are not visible from the current container — `
        + "in a PDB enable AWR_PDB_AUTOFLUSH_ENABLED (PDB-level snapshots) or connect to the CDB root.");
      continue;
    }
    const dbTime = Number(tm.find(x => x.STAT_NAME === "DB time")?.SECONDS ?? 0);
    const dbCpu = Number(tm.find(x => x.STAT_NAME === "DB CPU")?.SECONDS ?? 0);
    const ev = await rows(conn,
      `SELECT * FROM (
         SELECT e.event_name, e.wait_class, e.total_waits - NVL(b.total_waits, 0) AS waits,
                ROUND((e.time_waited_micro - NVL(b.time_waited_micro, 0)) / 1e6, 1) AS time_s,
                ROUND((e.time_waited_micro - NVL(b.time_waited_micro, 0))
                      / NULLIF(e.total_waits - NVL(b.total_waits, 0), 0) / 1e3, 2) AS avg_ms
         FROM ${p}_system_event e
         -- LEFT JOIN: events that first occurred after the begin snapshot have no baseline row
         LEFT JOIN ${p}_system_event b
           ON b.dbid = e.dbid AND b.instance_number = e.instance_number AND b.event_id = e.event_id AND b.snap_id = :b
         WHERE e.dbid = :dbid AND e.instance_number = :inst AND e.snap_id = :e
           AND e.wait_class <> 'Idle'
           AND e.time_waited_micro > NVL(b.time_waited_micro, 0)
         ORDER BY time_s DESC)
       WHERE ROWNUM <= :n`, { ...binds, n });
    const data: Row[] = [
      { EVENT_NAME: "DB CPU", WAIT_CLASS: "CPU", WAITS: null, TIME_S: dbCpu, AVG_MS: null },
      ...ev,
    ].sort((a, b) => Number(b.TIME_S) - Number(a.TIME_S)).slice(0, n)
      .map(r => ({ ...r, PCT_DBTIME: dbTime ? Math.round(1000 * Number(r.TIME_S) / dbTime) / 10 : null }));
    out.push(`${label}\nDB time ${dbTime}s, DB CPU ${dbCpu}s\n\n` + table(data, [
      ["TIME_S", "TIME_S"], ["PCT_DBTIME", "%DBTIME"], ["WAITS", "WAITS"], ["AVG_MS", "AVG_MS"],
      ["WAIT_CLASS", "WAIT_CLASS"], ["EVENT_NAME", "EVENT"],
    ]));
  }
  return out.join("\n\n");
}

async function sqlMonitor(conn: oracledb.Connection, args: Args): Promise<string> {
  if (args.sql_id) {
    const sqlId = sqlIdArg(args.sql_id);
    const r = await conn.execute<Row>(
      `${SQL_TAG} SELECT DBMS_SQLTUNE.REPORT_SQL_MONITOR(sql_id => :id, type => 'TEXT', report_level => 'ALL') AS report FROM dual`,
      { id: sqlId }, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { REPORT: { type: oracledb.STRING } } });
    const report = String(r.rows?.[0]?.REPORT ?? "").trim();
    // DBMS_SQLTUNE is invoker-rights: without access to V$SQL_MONITOR it returns only the title
    if (!/Global Information/.test(report)) {
      return `No SQL Monitor data for sql_id ${sqlId} — the statement was not monitored, has aged out, or the user `
        + "lacks SELECT on V$SQL_MONITOR / V$SQL_PLAN_MONITOR (see scripts/sql/grant_perf_privileges.sql)."
        + await packAccessNote(conn, "TUNING");
    }
    return report;
  }
  const n = limitArg(args.limit, 10);
  const data = await rows(conn,
    `SELECT * FROM (
       SELECT sql_id, sql_exec_id, status, username,
              TO_CHAR(sql_exec_start, 'YYYY-MM-DD HH24:MI:SS') AS started,
              ROUND(elapsed_time / 1e6, 1) AS elapsed_s, ROUND(cpu_time / 1e6, 1) AS cpu_s, buffer_gets,
              SUBSTR(REGEXP_REPLACE(sql_text, '\\s+', ' '), 1, 120) AS sql_text
       FROM v$sql_monitor
       WHERE sql_text IS NULL OR sql_text NOT LIKE '%oracle-mcp-server%'
       ORDER BY sql_exec_start DESC)
     WHERE ROWNUM <= :n`, { n });
  if (!data.length) return "No monitored SQL executions." + await packAccessNote(conn, "TUNING");
  return "Recent monitored executions (V$SQL_MONITOR):\n\n" + table(data, [
    ["SQL_ID", "SQL_ID"], ["SQL_EXEC_ID", "EXEC_ID"], ["STATUS", "STATUS"], ["USERNAME", "USER"], ["STARTED", "STARTED"],
    ["ELAPSED_S", "ELAPSED_S"], ["CPU_S", "CPU_S"], ["BUFFER_GETS", "GETS"], ["SQL_TEXT", "SQL_TEXT"],
  ]);
}

const HANDLERS: Record<string, (conn: oracledb.Connection, args: Args) => Promise<string>> = {
  explain_plan:     explainPlan,
  sql_plan:         sqlPlan,
  top_sql:          topSql,
  session_activity: sessionActivity,
  table_stats:      tableStats,
  ash_top:          ashTop,
  awr_top_events:   awrTopEvents,
  sql_monitor:      sqlMonitor,
};

/** Throws when the tool's feature is disabled for this session. */
export function assertPerfToolEnabled(name: string, features: PerfFeatures): void {
  const tool = PERF_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!features[tool.feature]) throw new Error(`Tool "${name}" is disabled: ${FEATURE_HINT[tool.feature]}.`);
}

/** Runs a performance tool; adds a privilege hint to ORA-00942 / ORA-01031 errors. */
export async function runPerfTool(name: string, args: Args, conn: oracledb.Connection, features: PerfFeatures): Promise<string> {
  assertPerfToolEnabled(name, features);
  // overrides the ACTION set at checkout; the next checkout sets all tags again
  conn.action = PERF_ACTION_PREFIX + name;
  try {
    return await HANDLERS[name](conn, args);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/^ORA-(00942|01031|04043)\b/.test(msg) && name !== "explain_plan") {
      throw new Error(msg + PRIV_HINT, { cause: err });
    }
    throw err;
  }
}
