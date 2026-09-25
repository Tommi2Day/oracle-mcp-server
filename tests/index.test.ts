import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeReq, makeRes, resBody } from "./helpers.js";

// ── Hoisted shared state (available inside vi.mock factories) ─────────────────
const { capturedHandlers, mockTransport, mockConn, mockPool, createPool } = vi.hoisted(() => {
  const capturedHandlers: Record<string, (req: any) => Promise<any>> = {};
  const mockTransport = { handleRequest: vi.fn().mockResolvedValue(undefined), onclose: undefined };
  const mockConn = {
    execute: vi.fn(),
    rollback: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    oracleServerVersionString: "23.5.0.24.07",
  };
  const mockPool = { getConnection: vi.fn(async () => mockConn), close: vi.fn().mockResolvedValue(undefined) };
  const createPool = vi.fn(async () => mockPool);
  return { capturedHandlers, mockTransport, mockConn, mockPool, createPool };
});

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("oracledb", () => ({
  default: {
    createPool, initOracleClient: vi.fn(),
    OUT_FORMAT_OBJECT: 4002, OUT_FORMAT_ARRAY: 4001, BIND_OUT: 3003, STRING: 2001, NUMBER: 2010,
    CLOB: 2017, NCLOB: 2018, BLOB: 2019, thin: true, versionString: "7.0.1",
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(function () {
    return {
      setRequestHandler: vi.fn((schema: string, handler: any) => { capturedHandlers[schema] = handler; }),
      connect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(function () { return mockTransport; }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: "LIST_TOOLS",
  CallToolRequestSchema: "CALL_TOOL",
}));

vi.mock("../src/lib.js", () => ({
  readFileEnv: vi.fn(),
  getAuthToken: vi.fn(() => ""),
  checkAuth: vi.fn().mockResolvedValue({ ok: true, name: "admin", connection: null }),
  checkAdminAuth: vi.fn(() => true),
  handleAdminRequest: vi.fn().mockResolvedValue(undefined),
  migrateTokenStore: vi.fn(),
  loadTokenStore: vi.fn(() => ({ tokens: [], next_id: 1 })),
  log: vi.fn(),
  isLogEnabled: vi.fn(() => false),
  getLogLevel: vi.fn(() => "info"),
  getClientIp: vi.fn(() => "10.0.0.1"),
}));

import {
  handleRequest, createMcpServer, getPool, poolCache, sessions, closeAllPools,
  toIdentifier, isReadOnlyStatement, formatCell, formatOracleType, featuresFor,
} from "../src/index.js";
import { checkAuth, handleAdminRequest, log } from "../src/lib.js";

async function callTool(name: string, args: Record<string, unknown> = {}) {
  createMcpServer(async () => mockPool as any, "tester", "1.2.3.4");
  return capturedHandlers.CALL_TOOL({ params: { name, arguments: args } });
}

beforeEach(() => {
  process.env.ORA_HOST = "dbhost";
  process.env.ORA_SERVICE_NAME = "FREEPDB1";
  process.env.ORA_USER = "app";
  process.env.ORA_PASSWORD = "pw";
});

afterEach(async () => {
  mockPool.getConnection.mockClear();
  mockConn.execute.mockReset();
  mockConn.rollback.mockClear();
  mockConn.close.mockClear();
  createPool.mockClear();
  await closeAllPools();
  sessions.clear();
  vi.mocked(checkAuth).mockResolvedValue({ ok: true, name: "admin", connection: null });
});

// ── getPool ───────────────────────────────────────────────────────────────────
describe("getPool", () => {
  it("creates the default pool from ORA_* env vars and caches it", async () => {
    const p1 = await getPool(null);
    const p2 = await getPool(null);
    expect(p1).toBe(p2);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      user: "app", password: "pw", connectString: "dbhost:1521/FREEPDB1", poolMin: 0,
    }));
  });

  it("creates a separate pool for a token connection", async () => {
    await getPool(null);
    await getPool({ tns_alias: "PROD", user: "other", password: "x" });
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(createPool).toHaveBeenLastCalledWith(expect.objectContaining({ connectString: "PROD", user: "other" }));
  });

  it("evicts the cache entry when pool creation fails", async () => {
    createPool.mockRejectedValueOnce(new Error("NJS-500") as never);
    await expect(getPool({ host: "bad" })).rejects.toThrow("NJS-500");
    expect(poolCache.size).toBe(0);
  });
});

// ── Tools ─────────────────────────────────────────────────────────────────────
describe("MCP tools", () => {
  const BASE_TOOLS = ["query", "execute", "list_tables", "describe_table", "list_schemas", "test_connection"];
  const PERF = ["explain_plan", "sql_plan", "top_sql", "session_activity", "table_stats"];

  it("lists base and unlicensed performance tools by default", async () => {
    createMcpServer(async () => mockPool as any);
    const { tools } = await capturedHandlers.LIST_TOOLS({});
    expect(tools.map((t: { name: string }) => t.name)).toEqual([...BASE_TOOLS, ...PERF]);
  });

  it("lists licensed tools only when the packs are enabled", async () => {
    createMcpServer(async () => mockPool as any, "t", "-", { perf: true, diagnostics: true, tuning: true });
    const { tools } = await capturedHandlers.LIST_TOOLS({});
    expect(tools.map((t: { name: string }) => t.name)).toEqual([...BASE_TOOLS, ...PERF, "ash_top", "awr_top_events", "sql_monitor"]);
  });

  it("hides all performance tools with perf=false", async () => {
    createMcpServer(async () => mockPool as any, "t", "-", { perf: false, diagnostics: false, tuning: false });
    const { tools } = await capturedHandlers.LIST_TOOLS({});
    expect(tools.map((t: { name: string }) => t.name)).toEqual(BASE_TOOLS);
  });

  it("refuses a disabled licensed tool without touching the database", async () => {
    const r = await callTool("ash_top");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Diagnostics Pack/);
    expect(mockPool.getConnection).not.toHaveBeenCalled();
  });

  it("featuresFor merges token overrides with ORA_* defaults", () => {
    process.env.ORA_DIAGNOSTICS_PACK = "true";
    try {
      // default connection is cached from the first test run, so only token overrides are checked here
      expect(featuresFor({ diagnostics_pack: false })).toMatchObject({ diagnostics: false });
      expect(featuresFor({ tuning_pack: "true" })).toMatchObject({ tuning: true });
    } finally {
      delete process.env.ORA_DIAGNOSTICS_PACK;
    }
  });

  it("dispatches performance tools", async () => {
    mockConn.execute.mockResolvedValueOnce({ rows: [{ LINE: "Plan hash value: 1" }, { LINE: "| 0 | SELECT STATEMENT |" }] });
    const r = await callTool("sql_plan", { sql_id: "abcdefghij123" });
    expect(r.content[0].text).toBe("Plan hash value: 1\n| 0 | SELECT STATEMENT |");
    expect(mockConn.close).toHaveBeenCalled();
  });

  it("query runs in a read-only transaction, formats rows and rolls back", async () => {
    mockConn.execute
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ metaData: [{ name: "ID" }, { name: "NAME" }], rows: [[1, "a"], [2, null]] });
    const r = await callTool("query", { sql: "SELECT id, name FROM t WHERE id > :1;", params: [0] });
    expect(mockConn.execute.mock.calls[0][0]).toBe("SET TRANSACTION READ ONLY");
    expect(mockConn.execute.mock.calls[1][0]).toBe("SELECT id, name FROM t WHERE id > :1");
    expect(mockConn.execute.mock.calls[1][1]).toEqual([0]);
    expect(r.content[0].text).toBe("ID | NAME\n─────────\n1 | a\n2 | \n(2 rows)");
    expect(mockConn.rollback).toHaveBeenCalled();
    expect(mockConn.close).toHaveBeenCalled();
  });

  it("query retries without read-only snapshot on ORA-01466", async () => {
    mockConn.execute
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("ORA-01466: unable to read data - table definition has changed"))
      .mockResolvedValueOnce({ metaData: [{ name: "X" }], rows: [[1]] });
    const r = await callTool("query", { sql: "SELECT x FROM new_table" });
    expect(r.content[0].text).toContain("(1 row)");
    expect(mockConn.rollback).toHaveBeenCalledTimes(2);
  });

  it("execute omits row count for DDL", async () => {
    mockConn.execute.mockResolvedValueOnce({ rowsAffected: 0 });
    const r = await callTool("execute", { sql: "CREATE TABLE t (x NUMBER)" });
    expect(r.content[0].text).toBe("✅ Statement executed.");
  });

  it("query rejects non-SELECT statements", async () => {
    const r = await callTool("query", { sql: "DROP TABLE t" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/only accepts SELECT/);
    expect(mockConn.execute).not.toHaveBeenCalled();
  });

  it("query truncates at the row limit", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => [i]);
    mockConn.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({ metaData: [{ name: "N" }], rows });
    const r = await callTool("query", { sql: "select n from t" });
    expect(r.content[0].text).toMatch(/showing first 200 rows/);
  });

  it("execute commits and reports rows affected", async () => {
    mockConn.execute.mockResolvedValueOnce({ rowsAffected: 3 });
    const r = await callTool("execute", { sql: "UPDATE t SET x = :x", params: { x: 1 } });
    expect(mockConn.execute).toHaveBeenCalledWith("UPDATE t SET x = :x", { x: 1 }, { autoCommit: true });
    expect(r.content[0].text).toMatch(/Rows affected: 3/);
  });

  it("execute returns DBMS_OUTPUT for PL/SQL blocks", async () => {
    mockConn.execute
      .mockResolvedValueOnce({})                                            // DBMS_OUTPUT.ENABLE
      .mockResolvedValueOnce({})                                            // block
      .mockResolvedValueOnce({ outBinds: { line: "hello", status: 0 } })
      .mockResolvedValueOnce({ outBinds: { line: null, status: 1 } });
    const r = await callTool("execute", { sql: "BEGIN dbms_output.put_line('hello'); END;\n/" });
    expect(mockConn.execute.mock.calls[1][0]).toBe("BEGIN dbms_output.put_line('hello'); END;");
    expect(r.content[0].text).toMatch(/DBMS_OUTPUT:\nhello/);
  });

  it("list_schemas hides Oracle-maintained users by default", async () => {
    mockConn.execute.mockResolvedValueOnce({ rows: [["APP"], ["HR"]] });
    const r = await callTool("list_schemas");
    expect(mockConn.execute.mock.calls[0][0]).toMatch(/oracle_maintained = 'N'/);
    expect(r.content[0].text).toBe("Schemas:\nAPP\nHR");
  });

  it("list_schemas falls back on pre-12c databases", async () => {
    mockConn.execute.mockRejectedValueOnce(new Error("ORA-00904")).mockResolvedValueOnce({ rows: [["SCOTT"]] });
    const r = await callTool("list_schemas");
    expect(r.content[0].text).toBe("Schemas:\nSCOTT");
  });

  it("list_tables upper-cases unquoted schema names", async () => {
    mockConn.execute.mockResolvedValueOnce({ rows: [["EMP", "TABLE", "HR"], ["EMP_V", "VIEW", "HR"]] });
    const r = await callTool("list_tables", { schema: "hr" });
    expect(mockConn.execute.mock.calls[0][1]).toEqual({ owner: "HR" });
    expect(r.content[0].text).toBe('Tables in "HR":\n  TABLE: EMP\n  VIEW: EMP_V');
  });

  it("list_tables reports an empty schema", async () => {
    mockConn.execute.mockResolvedValueOnce({ rows: [] });
    const r = await callTool("list_tables", { schema: '"MixedCase"' });
    expect(mockConn.execute.mock.calls[0][1]).toEqual({ owner: "MixedCase" });
    expect(r.content[0].text).toMatch(/No tables in schema "MixedCase"/);
  });

  it("describe_table formats Oracle types", async () => {
    mockConn.execute.mockResolvedValueOnce({ rows: [
      { OWNER: "HR", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: "N", KEY: "PK" },
      { OWNER: "HR", COLUMN_NAME: "NAME", DATA_TYPE: "VARCHAR2", CHAR_LENGTH: 50, CHAR_USED: "C", NULLABLE: "Y",
        DATA_DEFAULT: "'x' ", COMMENTS: "the name" },
    ] });
    const r = await callTool("describe_table", { table: "emp", schema: "hr" });
    expect(mockConn.execute.mock.calls[0][1]).toEqual({ owner: "HR", tab: "EMP" });
    expect(r.content[0].text).toContain("ID | NUMBER(10) | NO |  | PK | ");
    expect(r.content[0].text).toContain("NAME | VARCHAR2(50 CHAR) | YES | 'x' |  | the name");
  });

  it("describe_table reports a missing table", async () => {
    mockConn.execute.mockResolvedValueOnce({ rows: [] });
    const r = await callTool("describe_table", { table: "nope" });
    expect(r.content[0].text).toBe('Table "<current schema>.NOPE" not found.');
  });

  it("test_connection reports TCPS transport", async () => {
    mockConn.execute
      .mockResolvedValueOnce({ rows: [{ DB_NAME: "FREE", SERVICE_NAME: "FREEPDB1", SESSION_USER: "APP",
        CURRENT_SCHEMA: "APP", PROTOCOL: "tcps", SERVER_HOST: "db1", NOW: "2026-09-25" }] })
      .mockResolvedValueOnce({ rows: [["FREEPDB1"]] });
    const r = await callTool("test_connection");
    expect(r.content[0].text).toContain("Transport  : ✅ encrypted (TCPS)");
    expect(r.content[0].text).toContain("Database   : FREE (container FREEPDB1)");
    expect(r.content[0].text).toContain("thin mode");
  });

  it("returns isError and logs on database errors", async () => {
    mockConn.execute.mockRejectedValueOnce(new Error("ORA-00942: table or view does not exist"));
    const r = await callTool("execute", { sql: "DELETE FROM nope" });
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0].text).toBe("❌ Error: ORA-00942: table or view does not exist");
    expect(vi.mocked(log)).toHaveBeenCalledWith("error", "MCP", expect.stringContaining('token="tester"'));
  });

  it("rejects unknown tools", async () => {
    const r = await callTool("nope");
    expect(r.content[0].text).toMatch(/Unknown tool/);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
describe("helpers", () => {
  it("toIdentifier follows Oracle quoting rules", () => {
    expect(toIdentifier("emp")).toBe("EMP");
    expect(toIdentifier('"Emp"')).toBe("Emp");
    expect(toIdentifier("  ")).toBeNull();
    expect(toIdentifier(undefined)).toBeNull();
  });
  it("isReadOnlyStatement accepts SELECT/WITH only", () => {
    expect(isReadOnlyStatement("select 1 from dual")).toBe(true);
    expect(isReadOnlyStatement("-- c\n/* x */ (WITH a AS (SELECT 1 FROM dual) SELECT * FROM a)")).toBe(true);
    expect(isReadOnlyStatement("UPDATE t SET x = 1")).toBe(false);
    expect(isReadOnlyStatement("BEGIN NULL; END;")).toBe(false);
    expect(isReadOnlyStatement("SELECTED")).toBe(false);
  });
  it("formatCell handles dates, buffers and objects", () => {
    expect(formatCell(new Date("2026-01-02T03:04:05Z"), "TIMESTAMP WITH TIME ZONE")).toBe("2026-01-02T03:04:05.000Z");
    expect(formatCell(new Date(2026, 0, 2, 3, 4, 5), "DATE")).toBe("2026-01-02 03:04:05");
    expect(formatCell(new Date(2026, 0, 2, 3, 4, 5, 120), "TIMESTAMP")).toBe("2026-01-02 03:04:05.120");
    expect(formatCell(Buffer.from([0xab, 0x01]))).toBe("0xAB01");
    expect(formatCell(Buffer.alloc(64))).toBe("<binary 64 bytes>");
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell(null)).toBe("");
  });
  it("formatOracleType", () => {
    expect(formatOracleType({ DATA_TYPE: "NUMBER" })).toBe("NUMBER");
    expect(formatOracleType({ DATA_TYPE: "NUMBER", DATA_PRECISION: 8, DATA_SCALE: 2 })).toBe("NUMBER(8,2)");
    expect(formatOracleType({ DATA_TYPE: "NUMBER", DATA_PRECISION: null, DATA_SCALE: 0 })).toBe("INTEGER");
    expect(formatOracleType({ DATA_TYPE: "NVARCHAR2", CHAR_LENGTH: 20 })).toBe("NVARCHAR2(20)");
    expect(formatOracleType({ DATA_TYPE: "CHAR", CHAR_LENGTH: 1, CHAR_USED: "B" })).toBe("CHAR(1 BYTE)");
    expect(formatOracleType({ DATA_TYPE: "RAW", DATA_LENGTH: 16 })).toBe("RAW(16)");
    expect(formatOracleType({ DATA_TYPE: "TIMESTAMP(6)" })).toBe("TIMESTAMP(6)");
  });
});

// ── handleRequest ─────────────────────────────────────────────────────────────
describe("handleRequest", () => {
  it("GET /health", async () => {
    const res = makeRes();
    await handleRequest(makeReq("GET", "/health"), res);
    expect(resBody(res)).toEqual({ status: "ok", tls: false });
  });

  it("GET /info describes the default connection without password", async () => {
    const res = makeRes();
    await handleRequest(makeReq("GET", "/info"), res);
    const body = resBody(res);
    expect(body.name).toBe("oracle-mcp-server");
    expect(body.db).toMatchObject({ type: "host", host: "dbhost", service_name: "FREEPDB1", user: "app", driver_mode: "thin" });
    expect(JSON.stringify(body)).not.toContain("pw");
  });

  it("GET /admin serves the admin UI", async () => {
    const res = makeRes();
    await handleRequest(makeReq("GET", "/admin"), res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "text/html; charset=utf-8" }));
    expect(String(res.end.mock.calls[0][0])).toContain("oracle-mcp-server");
  });

  it("/admin/tokens delegates to handleAdminRequest", async () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(req, res, expect.any(Object));
  });

  it("/mcp stops when auth fails", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce({ ok: false });
    await handleRequest(makeReq("POST", "/mcp"), makeRes());
    expect(mockTransport.handleRequest).not.toHaveBeenCalled();
  });

  it("/mcp creates a new session transport", async () => {
    mockTransport.handleRequest.mockClear();
    await handleRequest(makeReq("POST", "/mcp"), makeRes());
    expect(mockTransport.handleRequest).toHaveBeenCalledTimes(1);
  });

  it("unknown paths return 404", async () => {
    const res = makeRes();
    await handleRequest(makeReq("GET", "/nope"), res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
  });
});
