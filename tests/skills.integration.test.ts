/**
 * Skills (skills/<name>/SKILL.md) against a real Oracle database, no mocks: the workflows the skills describe are
 * run through a real MCP client on sample data.
 *
 *   docker compose up -d oracle-test            # wait until healthy
 *   ORA_TEST_HOST=localhost npx vitest run tests/skills.integration.test.ts
 *
 * Skipped unless ORA_TEST_HOST is set (admin user ORA_TEST_ADMIN_USER / ORA_TEST_ADMIN_PASSWORD, default
 * system/manager; ORA_TEST_PORT=1521, ORA_TEST_SERVICE=FREEPDB1). Creates the schema MCPT_SK and drops it afterwards.
 *
 *  - every SQL block of every SKILL.md runs read-only through the `query` tool and returns the documented objects
 *  - oracle-db-status: test_connection + db_overview on a live database
 *  - oracle-problem-detection: locks / session_activity / db_overview find a real blocking chain (idle blocker, waiter)
 *    and the proposed KILL SESSION is not executed
 *  - oracle-top-sessions-sql / oracle-sql-tuning: top_sql, sql_plan, explain_plan, table_stats on a slow statement,
 *    and the plan changes after the recommended index
 *  - oracle-error-analysis: a real deadlock is found through alert_log → trace_files → trace_content
 */
import oracledb from "oracledb";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, getPool, initDriver, closeAllPools } from "../src/index.js";
import type { OraConnection } from "../src/oracle.js";
import { loadSkills } from "./skills-helpers.js";

const HOST = process.env.ORA_TEST_HOST as string;
const PORT = Number.parseInt(process.env.ORA_TEST_PORT || "1521", 10);
const SERVICE = process.env.ORA_TEST_SERVICE || "FREEPDB1";
const ADMIN = { user: process.env.ORA_TEST_ADMIN_USER || "system", password: process.env.ORA_TEST_ADMIN_PASSWORD || "manager" };
const SK = { user: "MCPT_SK", password: "skills_pw" };
const connectString = `${HOST}:${PORT}/${SERVICE}`;

/** Unique per run: a statement of an earlier run (dropped schema) must not be mistaken for ours in the shared pool. */
const MARK = `skilltest-${Date.now().toString(36)}`;
/** SQL_ID (first column) of the top_sql row whose text contains `marker`. */
const sqlIdOf = (output: string, marker: string): string =>
  output.split("\n").find(l => l.includes(marker))?.trim().split(/\s+/)[0] ?? "";
const text = (r: any): string => (r.content as { text: string }[]).map(c => c.text).join("\n");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const open = (u: { user: string; password: string }, module?: string) =>
  oracledb.getConnection({ user: u.user, password: u.password, connectString }).then(c => { if (module) c.module = module; return c; });

async function runSql(u: { user: string; password: string }, statements: string[], ignore: string[] = []): Promise<void> {
  const c = await open(u);
  try {
    for (const s of statements) {
      try { await c.execute(s, [], { autoCommit: true }); } catch (e) {
        if (!ignore.some(code => (e as Error).message.startsWith(code))) throw e;
      }
    }
  } finally { await c.close(); }
}

const SK_DDL = [
  `CREATE TABLE customers (id NUMBER PRIMARY KEY, name VARCHAR2(80 CHAR) NOT NULL, country VARCHAR2(2))`,
  `COMMENT ON TABLE customers IS 'Customer master data'`,
  `COMMENT ON COLUMN customers.name IS 'Legal name of the customer'`,
  `CREATE TABLE orders (id NUMBER PRIMARY KEY, customer_id NUMBER NOT NULL REFERENCES customers(id),
     amount NUMBER(10,2) NOT NULL CONSTRAINT orders_amount_ck CHECK (amount >= 0), note VARCHAR2(40))`,
  `CREATE TABLE payments (id NUMBER PRIMARY KEY, order_id NUMBER NOT NULL REFERENCES orders(id) ON DELETE CASCADE)`,
  `CREATE INDEX payments_order_idx ON payments (order_id)`,
  `CREATE VIEW big_orders AS SELECT id, amount FROM orders WHERE amount > 1000`,
  `CREATE SEQUENCE order_seq`,
  `CREATE PROCEDURE touch_customer(p_id NUMBER) AS BEGIN UPDATE customers SET name = name WHERE id = p_id; END;`,
  `CREATE TABLE locktest (id NUMBER PRIMARY KEY, v NUMBER)`,
  `CREATE TABLE dl (id NUMBER PRIMARY KEY, v NUMBER)`,
  `INSERT INTO customers SELECT level, 'c' || level, 'DE' FROM dual CONNECT BY level <= 50`,
  `INSERT INTO orders SELECT level, 1 + MOD(level, 50), level, 'n' || level FROM dual CONNECT BY level <= 20000`,
  `INSERT INTO locktest VALUES (1, 0)`,
  `INSERT INTO dl VALUES (1, 0)`,
  `INSERT INTO dl VALUES (2, 0)`,
  `COMMIT`,
];

describe.skipIf(!HOST)("Skills on the Oracle test database", () => {
  let client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const query = (sql: string, params?: unknown) => call("query", { sql, ...(params ? { params } : {}) });
  const adminConn: OraConnection = { host: HOST, port: PORT, service_name: SERVICE, ...ADMIN } as OraConnection;

  beforeAll(async () => {
    initDriver();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runSql(ADMIN, [`DROP USER ${SK.user} CASCADE`], ["ORA-01918"]);
    await runSql(ADMIN, [
      `CREATE USER ${SK.user} IDENTIFIED BY "${SK.password}" QUOTA UNLIMITED ON USERS`,
      `GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE PROCEDURE, CREATE SEQUENCE TO ${SK.user}`,
    ]);
    await runSql(SK, SK_DDL);
    await runSql(ADMIN, [`BEGIN DBMS_STATS.GATHER_SCHEMA_STATS('${SK.user}'); END;`]);
    // The skills' tools run as admin: the performance tools read V$ views and the diagnostic repository
    const server = createMcpServer(() => getPool(adminConn), "skills-test", "127.0.0.1", { perf: true, diagnostics: false, tuning: false });
    client = new Client({ name: "skills-it", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await closeAllPools();
    vi.restoreAllMocks();
    await runSql(ADMIN, [`DROP USER ${SK.user} CASCADE`], ["ORA-01918"]);
  }, 120_000);

  // ── SQL blocks of all skills ────────────────────────────────────────────────
  describe("SQL blocks of all skills", () => {
    const blocks = loadSkills().flatMap(s =>
      [...s.body.matchAll(/```sql\n([\s\S]*?)```/g)].map((m, index) => ({ skill: s.dir, index, sql: m[1].trim() })));

    it("finds SQL in the skills", () => {
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(new Set(blocks.map(b => b.skill))).toContain("oracle-document");
    });

    it.each(blocks.map(b => [`${b.skill} #${b.index + 1}`, b] as const))("%s runs through the query tool (read-only)", async (_n, b) => {
      expect(b.sql).toMatch(/^(SELECT|WITH)\b/i);
      const r = await query(b.sql.replaceAll("<OWNER>", SK.user));
      expect(r.isError, text(r)).toBeFalsy();
    });
  });

  // ── oracle-document ─────────────────────────────────────────────────────────
  describe("oracle-document documents a sample schema", () => {
    const sql = (i: number) => loadSkills().find(s => s.dir === "oracle-document")!.body
      .match(/```sql\n([\s\S]*?)```/g)![i].replace(/```sql\n|```/g, "").trim().replaceAll("<OWNER>", SK.user);

    it("list_tables / describe_table give objects, types, keys and comments", async () => {
      const tables = text(await call("list_tables", { schema: SK.user }));
      for (const t of ["TABLE: CUSTOMERS", "TABLE: ORDERS", "TABLE: PAYMENTS", "VIEW: BIG_ORDERS"]) expect(tables).toContain(t);
      const d = text(await call("describe_table", { schema: SK.user, table: "customers" }));
      expect(d).toMatch(/ID \| NUMBER \| NO \|.*\| PK/);
      expect(d).toContain("Legal name of the customer");
    });

    it("foreign key query lists the relationships with delete rule", async () => {
      const t = text(await query(sql(0)));
      expect(t).toMatch(/ORDERS[^\n]*CUSTOMERS[^\n]*ID[^\n]*NO ACTION/);
      expect(t).toMatch(/PAYMENTS[^\n]*ORDERS[^\n]*ID[^\n]*CASCADE/);
    });

    it("observation query finds the foreign key without index (and not the indexed one)", async () => {
      const t = text(await query(sql(1)));
      expect(t).toMatch(/ORDERS[^\n]*CUSTOMER_ID/);
      expect(t).not.toContain("PAYMENTS");
    });

    it("check constraints, code objects and statistics are reachable as the skill describes", async () => {
      const c = text(await query(
        `SELECT constraint_name, search_condition_vc FROM all_constraints WHERE owner = :1 AND constraint_type = 'C' AND constraint_name = 'ORDERS_AMOUNT_CK'`, [SK.user]));
      expect(c).toContain("amount >= 0");
      const o = text(await query(`SELECT object_type, object_name FROM all_objects WHERE owner = :1 AND object_type IN ('PROCEDURE','SEQUENCE') ORDER BY 1`, [SK.user]));
      expect(o).toContain("TOUCH_CUSTOMER");
      expect(o).toContain("ORDER_SEQ");
      const stats = text(await call("table_stats", { schema: SK.user, table: "orders" }));
      expect(stats).toContain("ORDERS");
      expect(stats).toMatch(/20000|20,000/);
    });
  });

  // ── oracle-db-status ────────────────────────────────────────────────────────
  describe("oracle-db-status", () => {
    it("test_connection and db_overview answer on a live database", async () => {
      expect(text(await call("test_connection"))).toContain("✅ Connection successful!");
      const ov = await call("db_overview");
      expect(ov.isError, text(ov)).toBeFalsy();
      expect(text(ov)).toMatch(/instance/i);
    });
  });

  // ── oracle-problem-detection: real blocking chain ───────────────────────────
  describe("oracle-problem-detection finds a blocking chain", () => {
    let blocker: oracledb.Connection; let waiter: oracledb.Connection; let blockerSid: number; let waiterSid: number;
    let waiterDone: Promise<unknown>;
    const sidOf = async (c: oracledb.Connection) => ((await c.execute<[number]>(`SELECT SYS_CONTEXT('USERENV','SID') FROM dual`)).rows![0][0]);

    beforeAll(async () => {
      blocker = await open(SK, "skilltest-blocker"); waiter = await open(SK, "skilltest-waiter");
      blockerSid = Number(await sidOf(blocker)); waiterSid = Number(await sidOf(waiter));
      await blocker.execute(`UPDATE locktest SET v = v + 1 WHERE id = 1`);                  // root blocker, then idle with open transaction
      waiterDone = waiter.execute(`UPDATE locktest SET v = v + 10 WHERE id = 1`).catch(e => e); // blocks
      const probe = await open(ADMIN);
      try {
        for (let i = 0; i < 50; i++) {
          const r = await probe.execute(`SELECT 1 FROM v$session WHERE sid = :1 AND blocking_session IS NOT NULL`, [waiterSid]);
          if (r.rows?.length) return;
          await sleep(200);
        }
        throw new Error("waiter never blocked");
      } finally { await probe.close(); }
    }, 30_000);

    afterAll(async () => {
      await blocker.rollback().catch(() => {});
      await waiterDone;
      await waiter.close().catch(() => {});
      await blocker.close().catch(() => {});
    });

    it("locks: root blocker is INACTIVE with the waiter behind it, locked object and a proposal", async () => {
      const t = text(await call("locks"));
      expect(t).toContain("Blocked sessions (1):");
      expect(t).toContain("enq: TX - row lock contention");
      expect(t).toContain(`${SK.user}.LOCKTEST`);
      expect(t).toContain("skilltest-blocker");
      expect(t).toContain("INACTIVE");
      expect(t).toMatch(new RegExp(`SID ${blockerSid} is INACTIVE`));
      expect(t).toMatch(new RegExp(`ALTER SYSTEM KILL SESSION '${blockerSid},\\d+' IMMEDIATE;`));
      expect(t).toContain("NOT executed by this tool");
    });

    it("session_activity shows the waiting session with its wait event and blocker", async () => {
      const t = text(await call("session_activity", { username: SK.user, include_idle: true }));
      expect(t).toContain("skilltest-waiter");
      expect(t).toContain("enq: TX - row lock contention");
      expect(t).toContain(String(blockerSid));
    });

    it("db_overview points at the blocked session", async () => {
      expect(text(await call("db_overview"))).toMatch(/blocked/i);
    });

    it("nothing was killed: the blocker is still there after all checks", async () => {
      const probe = await open(ADMIN);
      try {
        const r = await probe.execute<[string]>(`SELECT status FROM v$session WHERE sid = :1`, [blockerSid]);
        expect(r.rows?.[0]?.[0]).toBe("INACTIVE");
      } finally { await probe.close(); }
    });
  });

  // ── oracle-top-sessions-sql / oracle-sql-tuning ─────────────────────────────
  describe("top SQL and tuning workflow", () => {
    const SLOW = `SELECT /* ${MARK}-slow */ c.name, SUM(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.note LIKE :1 GROUP BY c.name`;
    let sqlId: string;

    beforeAll(async () => {
      const c = await open(SK, "skilltest-load");
      try {
        for (let i = 0; i < 5; i++) await c.execute(SLOW, ["n1%"]);
        await c.execute(`SELECT /*+ GATHER_PLAN_STATISTICS */ /* ${MARK}-gps */ COUNT(*) FROM orders WHERE note LIKE :1`, ["n1%"]);
      } finally { await c.close(); }
    });

    it("top_sql finds the statement for every sort key and filter", async () => {
      const orderBy = (await client.listTools()).tools.find(t => t.name === "top_sql")!.inputSchema.properties!.order_by as { enum: string[] };
      for (const order_by of orderBy.enum) {
        const r = await call("top_sql", { order_by, schema: SK.user, limit: 5 });
        expect(r.isError, `${order_by}: ${text(r)}`).toBeFalsy();
      }
      const t = text(await call("top_sql", { sql_text_like: `${MARK}-slow`, order_by: "elapsed_per_exec" }));
      expect(t).toContain(`${MARK}-slow`);
      sqlId = sqlIdOf(t, `${MARK}-slow`);
      expect(sqlId).toMatch(/^[0-9a-z]{13}$/);
      expect(text(await call("top_sql", { sql_text_like: "no-such-statement-xyz" }))).not.toContain(`${MARK}-slow`);
    });

    it("sql_plan shows the cached cursor's plan: full scan of ORDERS (no index on note)", async () => {
      const t = text(await call("sql_plan", { sql_id: sqlId }));
      expect(t).toMatch(/TABLE ACCESS FULL\s*\|\s*ORDERS/);
    });

    it("sql_plan with ALLSTATS LAST shows estimated vs. actual rows for a GATHER_PLAN_STATISTICS statement", async () => {
      const top = text(await call("top_sql", { sql_text_like: "GATHER_PLAN_STATISTICS" }));
      const id = sqlIdOf(top, `${MARK}-gps`);
      expect(id).toMatch(/^[0-9a-z]{13}$/);
      const t = text(await call("sql_plan", { sql_id: id, format: "ALLSTATS LAST" }));
      expect(t).toMatch(/A-Rows/);
      expect(t).toMatch(/E-Rows/);
    });

    it("explain_plan, table_stats, and the plan changes after the recommended index", async () => {
      const qualified = SLOW.replace(":1", "'n1%'").replace("customers c", `${SK.user}.customers c`).replace("orders o", `${SK.user}.orders o`);
      const before = text(await call("explain_plan", { sql: qualified }));
      expect(before).toMatch(/TABLE ACCESS FULL\s*\|\s*ORDERS/);
      const stats = text(await call("table_stats", { schema: SK.user, table: "orders" }));
      expect(stats).toContain("ORDERS");
      await runSql(SK, [`CREATE INDEX orders_note_idx ON orders (note)`]);
      await runSql(ADMIN, [`BEGIN DBMS_STATS.GATHER_TABLE_STATS('${SK.user}', 'ORDERS'); END;`]);
      const after = text(await call("explain_plan", { sql: `SELECT id FROM ${SK.user}.orders WHERE note = 'n1999'` }));
      expect(after).toMatch(/INDEX (RANGE|UNIQUE) SCAN\s*\|\s*ORDERS_NOTE_IDX/);
    });

    it("the unlicensed tool set has no licensed tools (skills only use what is listed)", async () => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).not.toContain("ash_top");
      expect(names).not.toContain("awr_top_events");
      expect(names).not.toContain("sql_monitor");
    });
  });

  // ── oracle-error-analysis: a real deadlock ──────────────────────────────────
  describe("oracle-error-analysis follows a deadlock from the alert log to the trace", () => {
    let traceFile = "";

    beforeAll(async () => {
      const s1 = await open(SK, "skilltest-dl1"); const s2 = await open(SK, "skilltest-dl2");
      try {
        await s1.execute(`UPDATE dl SET v = 1 WHERE id = 1`);
        await s2.execute(`UPDATE dl SET v = 2 WHERE id = 2`);
        const settle = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
        const a = settle(s1.execute(`UPDATE dl SET v = 11 WHERE id = 2`));
        await sleep(1000);
        const b = settle(s2.execute(`UPDATE dl SET v = 22 WHERE id = 1`));
        // Oracle rolls back only the victim's statement; the other session waits until the victim ends its transaction
        const first = await Promise.race([a, b, sleep(20_000).then(() => "timeout")]);
        expect(first).toContain("ORA-00060");
        await Promise.all([s1.rollback(), s2.rollback()]);
        await Promise.all([a, b]);
      } finally {
        await s1.rollback().catch(() => {}); await s2.rollback().catch(() => {});
        await s1.close().catch(() => {}); await s2.close().catch(() => {});
      }
    }, 40_000);

    it("alert_log with contains finds ORA-00060 and the trace file name", async () => {
      let t = "";
      for (let i = 0; i < 20 && !t.includes("ORA-00060"); i++) {
        t = text(await call("alert_log", { minutes: 15, contains: "ORA-00060" }));
        if (!t.includes("ORA-00060")) await sleep(1000);
      }
      expect(t).toContain("ORA-00060");
      traceFile = /[\w.-]+\.trc/.exec(t)?.[0] ?? "";
      expect(traceFile).toMatch(/_ora_\d+\.trc$/);
      expect(text(await call("alert_log", { minutes: 15, errors_only: true }))).toContain("ORA-00060");
    });

    it("trace_files lists the file and trace_content shows the deadlock graph with context", { timeout: 60_000 }, async () => {
      expect(traceFile).toBeTruthy();
      const files = text(await call("trace_files", { name_like: traceFile.replace(/\.trc$/, ""), minutes: 15 }));
      expect(files).toContain(traceFile);
      const g = text(await call("trace_content", { file: traceFile, contains: "Deadlock graph", context: 14, lines: 40 }));
      expect(g).toContain("Deadlock graph");
      expect(g).toMatch(/Resource Name|waiting/i);
      const sqlText = text(await call("trace_content", { file: traceFile, contains: "UPDATE", lines: 20 }));
      expect(sqlText).toMatch(/UPDATE dl SET/i);
      expect(text(await call("trace_content", { file: traceFile, position: "head", lines: 5 }))).toBeTruthy();
    });

    it("incidents answers (a plain deadlock is not an ADR incident)", async () => {
      const r = await call("incidents", { days: 1 });
      expect(r.isError, text(r)).toBeFalsy();
    });

    it("without log privileges the tools say how to get them (oracle-error-analysis ground rule)", async () => {
      const server = createMcpServer(() => getPool({ host: HOST, port: PORT, service_name: SERVICE, ...SK } as OraConnection),
        "skills-test-sk", "127.0.0.1", { perf: true, diagnostics: false, tuning: false });
      const c = new Client({ name: "sk", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), c.connect(b)]);
      try {
        const r = await c.callTool({ name: "alert_log", arguments: {} });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/ORA-0(0942|1031)/);
        expect(text(r)).toMatch(/grant_perf_privileges\.sql/);
      } finally { await c.close(); }
    });
  });
});
