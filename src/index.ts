#!/usr/bin/env node
/**
 * Oracle Database MCP Server
 *
 * Transport modes (TRANSPORT env var):
 *   stdio  – local Claude Desktop via stdio (no TLS needed)
 *   http   – HTTP or HTTPS depending on TLS_ENABLED
 *
 * Oracle connection (default / admin connection, see oracle.ts):
 *   ORA_CONNECT_STRING – Easy Connect, descriptor, TNS alias or JDBC URL
 *   ORA_TNS_ALIAS      – alias from $TNS_ADMIN/tnsnames.ora
 *   ORA_HOST/ORA_PORT/ORA_SERVICE_NAME|ORA_SID/ORA_PROTOCOL (tcp|tcps)
 *   TNS_ADMIN          – directory with tnsnames.ora, sqlnet.ora and wallet
 *   ORA_DRIVER_MODE    – thin (default, pure JS) | thick (Oracle Instant Client)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import oracledb from "oracledb";
import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  readFileEnv, getAuthToken,
  checkAuth, checkAdminAuth, handleAdminRequest, migrateTokenStore, loadTokenStore,
  log, isLogEnabled, getClientIp, getLogLevel,
} from "./lib.js";
import {
  connectionFromEnv, mergeConnection, resolvePoolAttributes, describeConnection,
  getDriverMode, normalizeSql, resolveConnectString, trustedCaFile, firstKeyword, toIdentifier, perfFeatures,
  sessionTags, programName,
  type OraConnection, type PerfFeatures, type SessionContext,
} from "./oracle.js";
import { formatCell } from "./format.js";
import { PERF_TOOL_NAMES, perfToolList, runPerfTool, assertPerfToolEnabled } from "./perf.js";

export { toIdentifier } from "./oracle.js";
export { formatCell, formatTable } from "./format.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

const mcpServerName = process.env.MCP_SERVER_NAME || "oracle-mcp-server";
const MAX_ROWS = parseInt(process.env.ORA_MAX_ROWS || "200", 10) || 200;

let cachedAdminHtml: Buffer | undefined;
try {
  const raw = fs.readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  cachedAdminHtml = Buffer.from(raw.replaceAll("__SERVER_NAME__", mcpServerName));
} catch { /* admin UI not available */ }

// ── Driver setup ─────────────────────────────────────────────────────────────
/** Global driver settings; switches to thick mode when ORA_DRIVER_MODE=thick. */
export function initDriver(): void {
  oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];
  oracledb.fetchAsBuffer = [oracledb.BLOB];
  if (getDriverMode() === "thick") {
    oracledb.initOracleClient({
      libDir:    process.env.ORA_CLIENT_LIB_DIR || undefined,
      configDir: process.env.TNS_ADMIN || undefined,
    });
  }
}

// ── Trusted CA certificates (TCPS with a private CA) ──────────────────────────
const trustedCaFiles = new Set<string>();
const extraCaCerts = new Set<string>();
let baseCaCerts: string[] | undefined;

/** Adds the certificates of a PEM file to the process-wide default CA set, which
 *  node-oracledb thin uses for TCPS when no key-bearing wallet is configured. */
export function registerTrustedCa(file: string): void {
  if (trustedCaFiles.has(file)) return;
  const pem = fs.readFileSync(file, "utf8");
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!certs.length) throw new Error(`No certificates found in ${file}`);
  if (typeof tls.setDefaultCACertificates !== "function") {
    throw new Error(`Node.js ${process.version} cannot add CA certificates at runtime — set NODE_EXTRA_CA_CERTS=${file} instead`);
  }
  baseCaCerts ??= tls.getCACertificates("default");
  certs.forEach(c => extraCaCerts.add(c));
  tls.setDefaultCACertificates([...baseCaCerts, ...extraCaCerts]);
  trustedCaFiles.add(file);
  log("info", "DB", `Trusting ${certs.length} CA certificate(s) from ${file}`);
}

// ── Pool cache ────────────────────────────────────────────────────────────────
/** SHA-256 of the effective pool attributes → pool promise. Tokens with identical
 *  effective connections share one pool. */
export const poolCache = new Map<string, Promise<oracledb.Pool>>();

let defaultConnection: OraConnection | undefined;
export function getDefaultConnection(): OraConnection {
  defaultConnection ??= connectionFromEnv();
  return defaultConnection;
}

function poolOptions() {
  return {
    mode:           getDriverMode(),
    poolMax:        parseInt(process.env.ORA_POOL_MAX || "5", 10) || 5,
    connectTimeout: parseInt(process.env.ORA_CONNECT_TIMEOUT || "10", 10) || 10,
    program:        programName(mcpServerName),
  };
}

/** Effective pool attributes, the certificate-only CA file (if any) and the cache key.
 *  The CA file is part of the key: it changes TLS trust without appearing in attrs. */
function resolvePool(connection: OraConnection | null) {
  const merged = mergeConnection(connection, getDefaultConnection());
  const attrs = resolvePoolAttributes(merged, poolOptions());
  const caFile = trustedCaFile(merged, poolOptions());
  const key = createHash("sha256").update(JSON.stringify({ attrs, caFile })).digest("hex");
  return { merged, attrs, caFile, key };
}

function poolKey(connection: OraConnection | null): string {
  return resolvePool(connection).key;
}

/** Return the pool for a per-token connection, or the default pool if null. */
export function getPool(connection: OraConnection | null): Promise<oracledb.Pool> {
  const { merged, attrs, caFile, key } = resolvePool(connection);
  const parsed = resolveConnectString(merged);
  if (parsed.ignoredParams.length) {
    log("warn", "DB", `Ignoring JDBC-only connect string properties: ${parsed.ignoredParams.join(", ")}`);
  }
  let p = poolCache.get(key);
  if (!p) {
    if (caFile) registerTrustedCa(caFile);
    const target = describeConnection(merged, poolOptions().mode).connect_string;
    log("debug", "DB", `Creating pool for ${target} user="${attrs.user ?? ""}"`);
    p = oracledb.createPool(attrs as oracledb.PoolAttributes).catch((err: Error) => {
      poolCache.delete(key);
      log("error", "DB", `Pool creation failed (${target}): ${err.message}`);
      throw err;
    });
    poolCache.set(key, p);
  }
  return p;
}

/** Close the pool of a removed/changed token unless another active token still uses it. */
function releasePool(connection: OraConnection | null): void {
  if (!connection) return;
  let key: string;
  try { key = poolKey(connection); } catch { return; }
  if (key === safePoolKey(null)) return;
  const stillUsed = loadTokenStore().tokens.some(t => t.active && t.connection && safePoolKey(t.connection) === key);
  if (stillUsed) return;
  const p = poolCache.get(key);
  if (!p) return;
  poolCache.delete(key);
  p.then(pool => pool.close(5)).catch(() => {});
}

function safePoolKey(connection: OraConnection | null): string | null {
  try { return poolKey(connection); } catch { return null; }
}

export async function closeAllPools(): Promise<void> {
  const pools = [...poolCache.values()];
  poolCache.clear();
  await Promise.allSettled(pools.map(p => p.then(pool => pool.close(5))));
}

// ── SQL helpers ───────────────────────────────────────────────────────────────
type PoolProvider = () => Promise<oracledb.Pool>;
type Binds = oracledb.BindParameters;

/** Sets MODULE / ACTION / CLIENT_IDENTIFIER / CLIENT_INFO of a pooled session (sent with the
 *  next round trip, no extra call). Set on every checkout because tokens with the same
 *  effective connection share a pool. */
export function tagSession(conn: oracledb.Connection, ctx: SessionContext): void {
  const tags = sessionTags(ctx);
  conn.module = tags.module;
  conn.action = tags.action;
  conn.clientId = tags.clientId;
  conn.clientInfo = tags.clientInfo;
}

async function withConnection<T>(getDbPool: PoolProvider, ctx: SessionContext,
  fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
  const pool = await getDbPool();
  const conn = await pool.getConnection();
  tagSession(conn, ctx);
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Only SELECT / WITH statements are allowed in the read-only query tool. DDL would
 *  implicitly commit and end a SET TRANSACTION READ ONLY transaction. */
export function isReadOnlyStatement(sql: string): boolean {
  return ["SELECT", "WITH"].includes(firstKeyword(sql));
}

function toBinds(params: unknown): Binds {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params) || typeof params === "object") return params as Binds;
  throw new Error('"params" must be an array (positional :1, :2, …) or an object (named :name)');
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

async function fetchDbmsOutput(conn: oracledb.Connection, maxLines = 1000): Promise<string[]> {
  const lines: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const r = await conn.execute<{ line: string | null; status: number }>(
      "BEGIN DBMS_OUTPUT.GET_LINE(:line, :status); END;",
      { line: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
        status: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
    );
    const out = r.outBinds as { line: string | null; status: number };
    if (out.status !== 0) break;
    lines.push(out.line ?? "");
  }
  return lines;
}

// ── MCP server factory ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "query",
    description: "Execute a read-only SQL SELECT (or WITH …) query and return the results. "
      + `At most ${MAX_ROWS} rows are returned. Bind variables use Oracle syntax (:1, :2 or :name).`,
    inputSchema: {
      type: "object",
      properties: {
        sql:    { type: "string", description: "SQL SELECT query (no trailing semicolon needed)" },
        params: { type: ["array", "object"], description: "Bind values: array for :1, :2, … or object for :name" },
      },
      required: ["sql"],
    },
  },
  {
    name: "execute",
    description: "Execute a SQL statement (INSERT, UPDATE, DELETE, MERGE, DDL) or a PL/SQL block. "
      + "Changes are committed. DBMS_OUTPUT of PL/SQL blocks is returned.",
    inputSchema: {
      type: "object",
      properties: {
        sql:    { type: "string", description: "SQL statement or PL/SQL block (BEGIN … END;)" },
        params: { type: ["array", "object"], description: "Bind values: array for :1, :2, … or object for :name" },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_tables",
    description: "List tables, views and materialized views in a schema",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema (owner) name, default: current schema. Unquoted names are upper-cased." },
      },
    },
  },
  {
    name: "describe_table",
    description: "Show columns, types, nullability, defaults, primary key and comments of a table or view",
    inputSchema: {
      type: "object",
      properties: {
        table:  { type: "string", description: "Table or view name. Unquoted names are upper-cased." },
        schema: { type: "string", description: "Schema (owner) name, default: current schema" },
      },
      required: ["table"],
    },
  },
  {
    name: "list_schemas",
    description: "List all schemas (users) visible to the connected user",
    inputSchema: {
      type: "object",
      properties: {
        include_system: { type: "boolean", description: "Include Oracle-maintained schemas (SYS, SYSTEM, …)", default: false },
      },
    },
  },
  {
    name: "test_connection",
    description: "Test the database connection and return server info",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Performance tool features of a token's effective connection (default connection for null). */
export function featuresFor(connection: OraConnection | null): PerfFeatures {
  return perfFeatures(mergeConnection(connection, getDefaultConnection()));
}

export function createMcpServer(getDbPool: PoolProvider = () => getPool(null), tokenName = "unknown", clientIp = "-",
  features: PerfFeatures = featuresFor(null)): Server {
  const server = new Server(
    { name: mcpServerName, version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS, ...perfToolList(features)] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const session: SessionContext = { server: mcpServerName, version, token: tokenName, ip: clientIp, tool: name };
    log("info", "MCP", `token="${tokenName}" action="${name}" ip="${clientIp}"${formatToolParams(args)}`);
    try {
      switch (name) {
        case "test_connection":
          return await withConnection(getDbPool, session, async (conn) => {
            const res = await conn.execute<Record<string, string>>(
              `SELECT SYS_CONTEXT('USERENV','DB_NAME') AS db_name,
                      SYS_CONTEXT('USERENV','SERVICE_NAME') AS service_name,
                      SYS_CONTEXT('USERENV','SESSION_USER') AS session_user,
                      SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS current_schema,
                      SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') AS protocol,
                      SYS_CONTEXT('USERENV','SERVER_HOST') AS server_host,
                      TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS now
               FROM dual`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
            const r = res.rows?.[0] ?? {};
            let container = "";
            try {
              const c = await conn.execute<[string]>("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM dual");
              container = c.rows?.[0]?.[0] ?? "";
            } catch { /* pre-12c database */ }
            const proto = (r.PROTOCOL || "").toLowerCase();
            const tls = proto === "tcps" ? "✅ encrypted (TCPS)" : proto ? `⚠️ ${proto} (no TLS)` : "unknown";
            return text(
              `✅ Connection successful!\n\n`
              + `Database   : ${r.DB_NAME ?? ""}${container ? ` (container ${container})` : ""}\n`
              + `Service    : ${r.SERVICE_NAME ?? ""}\n`
              + `Server     : ${r.SERVER_HOST ?? ""}\n`
              + `User       : ${r.SESSION_USER ?? ""} (schema ${r.CURRENT_SCHEMA ?? ""})\n`
              + `Time       : ${r.NOW ?? ""}\n`
              + `Transport  : ${tls}\n`
              + `Driver     : node-oracledb ${oracledb.versionString} (${oracledb.thin ? "thin" : "thick"} mode)\n`
              + `Version    : ${conn.oracleServerVersionString ?? ""}`);
          });

        case "list_schemas":
          return await withConnection(getDbPool, session, async (conn) => {
            let rows: string[];
            try {
              const res = await conn.execute<[string]>(
                args.include_system
                  ? "SELECT username FROM all_users ORDER BY username"
                  : "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username");
              rows = (res.rows ?? []).map(r => r[0]);
            } catch {
              // oracle_maintained exists since 12c
              const res = await conn.execute<[string]>("SELECT username FROM all_users ORDER BY username");
              rows = (res.rows ?? []).map(r => r[0]);
            }
            return text(`Schemas:\n${rows.join("\n")}`);
          });

        case "list_tables":
          return await withConnection(getDbPool, session, async (conn) => {
            const res = await conn.execute<[string, string, string]>(
              `SELECT o.object_name, o.object_type, NVL(:owner, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AS owner
               FROM all_objects o
               WHERE o.owner = NVL(:owner, SYS_CONTEXT('USERENV','CURRENT_SCHEMA'))
                 AND o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
                 AND o.object_name NOT LIKE 'BIN$%'
                 AND o.secondary = 'N'
               ORDER BY o.object_type, o.object_name`,
              { owner: toIdentifier(args.schema as string | undefined) });
            const rows = res.rows ?? [];
            let owner = rows[0]?.[2] ?? toIdentifier(args.schema as string | undefined);
            if (!owner) {
              const cs = await conn.execute<[string]>("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual");
              owner = cs.rows?.[0]?.[0] ?? "current schema";
            }
            if (!rows.length) return text(`No tables in schema "${owner}".`);
            return text(`Tables in "${owner}":\n${rows.map(r => `  ${r[1]}: ${r[0]}`).join("\n")}`);
          });

        case "describe_table":
          return await withConnection(getDbPool, session, async (conn) => {
            if (!args.table) throw new Error('"table" is required');
            const res = await conn.execute<Record<string, unknown>>(
              `SELECT c.owner, c.column_name, c.data_type, c.data_length, c.char_length, c.char_used,
                      c.data_precision, c.data_scale, c.nullable, c.data_default, cc.comments,
                      CASE WHEN EXISTS (
                        SELECT 1 FROM all_constraints k
                        JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
                        WHERE k.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name
                          AND kc.column_name = c.column_name) THEN 'PK' END AS key
               FROM all_tab_columns c
               LEFT JOIN all_col_comments cc
                 ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
               WHERE c.owner = NVL(:owner, SYS_CONTEXT('USERENV','CURRENT_SCHEMA'))
                 AND c.table_name = :tab
               ORDER BY c.column_id`,
              { owner: toIdentifier(args.schema as string | undefined), tab: toIdentifier(args.table as string) },
              { outFormat: oracledb.OUT_FORMAT_OBJECT });
            const rows = res.rows ?? [];
            const label = `${toIdentifier(args.schema as string | undefined) ?? "<current schema>"}.${toIdentifier(args.table as string)}`;
            if (!rows.length) return text(`Table "${label}" not found.`);
            const lines = rows.map(r => [
              r.COLUMN_NAME, formatOracleType(r), r.NULLABLE === "Y" ? "YES" : "NO",
              String(r.DATA_DEFAULT ?? "").trim(), r.KEY ?? "", r.COMMENTS ?? "",
            ].join(" | "));
            return text(`Table: ${rows[0].OWNER}.${toIdentifier(args.table as string)}\n${"─".repeat(60)}\n`
              + `Column | Type | Nullable | Default | Key | Comment\n${"─".repeat(60)}\n${lines.join("\n")}`);
          });

        case "query":
          return await withConnection(getDbPool, session, async (conn) => {
            const sql = normalizeSql(String(args.sql ?? ""));
            if (!isReadOnlyStatement(sql)) {
              throw new Error("The query tool only accepts SELECT or WITH statements — use the execute tool for DML, DDL or PL/SQL.");
            }
            const run = () => conn.execute<unknown[]>(sql, toBinds(args.params),
              { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: MAX_ROWS + 1 });
            try {
              await conn.execute("SET TRANSACTION READ ONLY");
              let res: oracledb.Result<unknown[]>;
              try {
                res = await run();
              } catch (err) {
                // ORA-01466: a read-only snapshot cannot see objects whose DDL is only
                // seconds old. Retry outside the read-only transaction — the statement
                // is still SELECT/WITH only and everything is rolled back afterwards.
                if (!/^ORA-01466\b/.test((err as Error).message)) throw err;
                log("debug", "MCP", "ORA-01466 in read-only transaction, retrying without snapshot");
                await conn.rollback();
                res = await run();
              }
              const rows = res.rows ?? [];
              if (!rows.length) return text("Query returned 0 rows.");
              const cols = (res.metaData ?? []).map(m => m.name);
              const types = (res.metaData ?? []).map(m => m.dbTypeName);
              const header = cols.join(" | ");
              const body = rows.slice(0, MAX_ROWS).map(r => r.map((v, i) => formatCell(v, types[i])).join(" | "));
              const note = rows.length > MAX_ROWS
                ? `\n(showing first ${MAX_ROWS} rows, more available)`
                : `\n(${rows.length} row${rows.length !== 1 ? "s" : ""})`;
              return text(`${header}\n${"─".repeat(Math.min(header.length, 120))}\n${body.join("\n")}${note}`);
            } finally {
              await conn.rollback().catch(() => {});
            }
          });

        case "execute":
          return await withConnection(getDbPool, session, async (conn) => {
            const sql = normalizeSql(String(args.sql ?? ""));
            const plsql = /^\s*(BEGIN|DECLARE)\b/i.test(sql);
            if (plsql) await conn.execute("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;");
            const res = await conn.execute(sql, toBinds(args.params), { autoCommit: true });
            let msg = "✅ Statement executed.";
            if (res.rowsAffected !== undefined && /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) {
              msg += `\nRows affected: ${res.rowsAffected}`;
            }
            if (res.outBinds !== undefined) msg += `\nOut binds: ${JSON.stringify(res.outBinds)}`;
            if (plsql) {
              const output = await fetchDbmsOutput(conn);
              if (output.length) msg += `\n\nDBMS_OUTPUT:\n${output.join("\n")}`;
            }
            return text(msg);
          });

        default:
          if (PERF_TOOL_NAMES.has(name)) {
            assertPerfToolEnabled(name, features);
            return text(await withConnection(getDbPool, session, conn => runPerfTool(name, args, conn, features)));
          }
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const e = err as Error;
      const msg = e?.message || String(err) || JSON.stringify(err);
      log("error", "MCP", `token="${tokenName}" action="${name}" ip="${clientIp}" error=${JSON.stringify(msg)}`);
      return { content: [{ type: "text", text: `❌ Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

/** Oracle column type as shown in SQL*Plus DESCRIBE. */
export function formatOracleType(r: Record<string, unknown>): string {
  const t = String(r.DATA_TYPE ?? "");
  if (/^(N?VARCHAR2|N?CHAR)$/.test(t)) {
    const unit = t.startsWith("N") ? "" : r.CHAR_USED === "C" ? " CHAR" : " BYTE";
    return `${t}(${r.CHAR_LENGTH ?? r.DATA_LENGTH}${unit})`;
  }
  if (t === "RAW") return `RAW(${r.DATA_LENGTH})`;
  if (t === "NUMBER") {
    if (r.DATA_PRECISION === null || r.DATA_PRECISION === undefined) return r.DATA_SCALE === 0 ? "INTEGER" : "NUMBER";
    return r.DATA_SCALE ? `NUMBER(${r.DATA_PRECISION},${r.DATA_SCALE})` : `NUMBER(${r.DATA_PRECISION})`;
  }
  if (t === "FLOAT" && r.DATA_PRECISION) return `FLOAT(${r.DATA_PRECISION})`;
  return t;
}

/** Tool params for the log line. SQL text is only included at debug level;
 *  otherwise it is replaced by its length so statements with literals don't leak into logs. */
function formatToolParams(args: Record<string, unknown>): string {
  if (!args || !Object.keys(args).length) return "";
  if (isLogEnabled("debug") || typeof args.sql !== "string") return " params=" + JSON.stringify(args);
  return " params=" + JSON.stringify({ ...args, sql: `<${args.sql.length} chars, LOG_LEVEL=debug to show>` });
}

// ── Session store (stateful HTTP sessions) ────────────────────────────────────
export const sessions = new Map<string, StreamableHTTPServerTransport>();

// ── Request handler (shared by both HTTP and HTTPS) ───────────────────────────
export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    await _handleRequest(req, res);
  } catch (err) {
    const e = err as Error;
    log("error", "HTTP", `Unhandled error for ${req.method} ${req.url}: ${e.message}`);
    if (e.stack) log("error", "HTTP", e.stack);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

async function _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if ((req.url === "/admin" || req.url === "/admin/") && req.method === "GET") {
    if (cachedAdminHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(cachedAdminHtml);
    } else {
      res.writeHead(404);
      res.end("Admin UI not found");
    }
    return;
  }
  if (req.url === "/health" && req.method === "GET") {
    const tlsEnabled = (process.env.TLS_ENABLED || "false").toLowerCase() !== "false";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", tls: tlsEnabled }));
    return;
  }
  if (req.url === "/info" && req.method === "GET") {
    if (!checkAdminAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: mcpServerName,
      version,
      db: describeConnection(getDefaultConnection(), getDriverMode()),
      features: featuresFor(null),
    }));
    return;
  }
  if (req.url?.startsWith("/admin/tokens")) {
    await handleAdminRequest(req, res, {
      onDelete: (token) => releasePool(token.connection),
      onUpdate: (before, after) => {
        if (JSON.stringify(before.connection) !== JSON.stringify(after.connection) || !after.active) {
          releasePool(before.connection);
        }
      },
    });
    return;
  }
  if (req.url === "/mcp") {
    const auth = await checkAuth(req, res);
    if (!auth.ok) return;

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res);
    } else {
      // New session — pool for this token is resolved lazily on the first tool call
      const connection = auth.connection;
      const clientIp = getClientIp(req);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          const startedAt = Date.now();
          log("info", "SESSION", `token="${auth.name}" action="start" session="${id}" ip="${clientIp}"`);
          // Chain instead of overwrite: server.connect() already installed its own onclose
          const prevOnClose = transport.onclose;
          transport.onclose = () => {
            sessions.delete(id);
            const duration = Math.round((Date.now() - startedAt) / 1000);
            log("info", "SESSION", `token="${auth.name}" action="stop" session="${id}" ip="${clientIp}" duration=${duration}s`);
            prevOnClose?.();
          };
        },
      });
      const server = createMcpServer(() => getPool(connection), auth.name, clientIp, featuresFor(connection));
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}

// ── Startup (only when run directly) ─────────────────────────────────────────
async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log("error", "FATAL", `Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) log("error", "FATAL", reason.stack);
  });
  process.on("uncaughtException", (err) => {
    log("error", "FATAL", `Uncaught exception: ${err.message}`);
    if (err.stack) log("error", "FATAL", err.stack);
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      closeAllPools().finally(() => process.exit(0));
    });
  }

  try {
    initDriver();
  } catch (err) {
    console.error(`❌ Cannot initialise Oracle client (ORA_DRIVER_MODE=thick): ${(err as Error).message}`);
    process.exit(1);
  }
  migrateTokenStore();

  if (process.env.ORA_TLS_CA_FILE) {
    try {
      registerTrustedCa(process.env.ORA_TLS_CA_FILE);
    } catch (err) {
      console.error(`❌ ORA_TLS_CA_FILE: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const dbInfo = describeConnection(getDefaultConnection(), getDriverMode());
  if (dbInfo.error) {
    console.error(`❌ Invalid default Oracle connection: ${dbInfo.error}`);
    process.exit(1);
  }
  const dbLine = `${dbInfo.connect_string} user=${dbInfo.user ?? "-"} (${getDriverMode()} mode)`;
  const f = featuresFor(null);
  const onOff = (b: boolean) => (b ? "on" : "off");
  const perfLine = `performance tools ${onOff(f.perf)}, Diagnostics Pack ${onOff(f.diagnostics)}, Tuning Pack ${onOff(f.tuning)}`;
  if (f.tuning && !f.diagnostics) {
    log("warn", "CONFIG", "ORA_TUNING_PACK is enabled without ORA_DIAGNOSTICS_PACK — the Tuning Pack requires a Diagnostics Pack licence.");
  }

  const TRANSPORT   = (process.env.TRANSPORT   || "stdio").toLowerCase();
  const TLS_ENABLED = (process.env.TLS_ENABLED || "false").toLowerCase() !== "false";
  const PORT        = parseInt(process.env.PORT || "3000", 10);

  if (TRANSPORT === "http") {
    const authInfo = getAuthToken()
      ? "🔑 Bearer token required (env + file tokens)"
      : "⚠️  disabled (AUTH_TOKEN not set)";
    const banner = (scheme: string) => {
      console.error(`Oracle MCP Server (${scheme.toUpperCase()}) listening on port ${PORT}`);
      console.error(`  MCP endpoint : ${scheme}://localhost:${PORT}/mcp`);
      console.error(`  Admin UI     : ${scheme}://localhost:${PORT}/admin`);
      console.error(`  Admin API    : ${scheme}://localhost:${PORT}/admin/tokens`);
      console.error(`  Health check : ${scheme}://localhost:${PORT}/health`);
      console.error(`  Database     : ${dbLine}`);
      console.error(`  Features     : ${perfLine}`);
      console.error(`  Auth         : ${authInfo}`);
      console.error(`  Log level    : ${getLogLevel()}`);
    };

    if (TLS_ENABLED) {
      const cert = readFileEnv("TLS_CERT_FILE");
      const key  = readFileEnv("TLS_KEY_FILE");
      if (!cert || !key) {
        console.error("❌ TLS_ENABLED=true requires TLS_CERT_FILE and TLS_KEY_FILE.");
        process.exit(1);
      }
      const tlsOptions: https.ServerOptions = { cert, key };
      const ca = readFileEnv("TLS_CA_FILE");
      if (ca) {
        tlsOptions.ca = ca;
        tlsOptions.requestCert = true;
        tlsOptions.rejectUnauthorized = true;
        console.error("🔐 mTLS enabled – client certificates required.");
      }
      https.createServer(tlsOptions, handleRequest).listen(PORT, () => banner("https"));
    } else {
      http.createServer(handleRequest).listen(PORT, () => banner("http"));
    }
  } else {
    const server    = createMcpServer(() => getPool(null), "stdio", "local");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Oracle MCP Server running on stdio – ${dbLine} – ${perfLine}`);
  }
}

if (isMain) await main();
