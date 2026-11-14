/**
 * Integration tests against a real Oracle database (docker compose oracle-test), no mocks for oracledb or the MCP SDK.
 *
 *   docker compose up -d oracle-test            # gvenzl/oracle-free, wait until healthy
 *   ORA_TEST_HOST=localhost npx vitest run tests/oracle.integration.test.ts
 *
 * Skipped unless ORA_TEST_HOST is set. Needs an admin user (ORA_TEST_ADMIN_USER / ORA_TEST_ADMIN_PASSWORD, default
 * system/manager, service ORA_TEST_SERVICE=FREEPDB1, port ORA_TEST_PORT=1521); creates the schemas MCPT_SALES and
 * MCPT_HR and the user MCPT_READER and drops them afterwards.
 *
 *  1. every MCP tool through a real MCP client (in-memory transport) on the sample "sales" schema,
 *     the performance tools as admin
 *  2. end to end over HTTP with OAuth: the group / e-mail of the user decides the schema, MODULE and
 *     CLIENT_IDENTIFIER carry the user's e-mail (checked in V$SESSION), client-supplied credentials are
 *     enforced by Oracle itself, the admin API manages assignments (fake identity provider, real fetch for the rest)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import oracledb from "oracledb";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer, getPool, handleRequest, initDriver, closeAllPools, sessions } from "../src/index.js";
import { clearTokenStoreCache } from "../src/lib.js";
import { clearOAuthCache } from "../src/oauth.js";
import type { OraConnection } from "../src/oracle.js";
import { makeIdp, ISSUER, AUDIENCE } from "./oidc-helpers.js";

const HOST = process.env.ORA_TEST_HOST as string;
const PORT = Number.parseInt(process.env.ORA_TEST_PORT || "1521", 10);
const SERVICE = process.env.ORA_TEST_SERVICE || "FREEPDB1";
const ADMIN = { user: process.env.ORA_TEST_ADMIN_USER || "system", password: process.env.ORA_TEST_ADMIN_PASSWORD || "manager" };
const SALES = { user: "MCPT_SALES", password: "sales_pw" };
const HR = { user: "MCPT_HR", password: "hr_pw" };
const READER = { user: "MCPT_READER", password: "reader_pw" };

const target = { host: HOST, port: PORT, service_name: SERVICE };
const conn = (u: { user: string; password: string }): OraConnection => ({ ...target, ...u } as OraConnection);
const text = (r: any): string => (r.content as { text: string }[]).map(c => c.text).join("\n");

/** Runs statements (one round trip each) as the given user; errors listed in `ignore` (ORA-xxxxx) are skipped. */
async function runSql(u: { user: string; password: string }, statements: string[], ignore: string[] = []): Promise<void> {
  const c = await oracledb.getConnection({ user: u.user, password: u.password, connectString: `${HOST}:${PORT}/${SERVICE}` });
  try {
    for (const s of statements) {
      try { await c.execute(s, [], { autoCommit: true }); } catch (e) {
        if (!ignore.some(code => (e as Error).message.startsWith(code))) throw e;
      }
    }
  } finally { await c.close(); }
}

async function dropAll(): Promise<void> {
  await runSql(ADMIN, [SALES, HR, READER].map(u => `DROP USER ${u.user} CASCADE`), ["ORA-01918"]);
}

const createUser = (u: { user: string; password: string }, privileges: string): string[] => [
  `CREATE USER ${u.user} IDENTIFIED BY "${u.password}" QUOTA UNLIMITED ON USERS`,
  `GRANT ${privileges} TO ${u.user}`,
];

const SALES_DDL = [
  `CREATE TABLE customers (id NUMBER PRIMARY KEY, name VARCHAR2(80 CHAR) NOT NULL, country VARCHAR2(2))`,
  `CREATE TABLE orders (id NUMBER PRIMARY KEY, customer_id NUMBER NOT NULL REFERENCES customers(id), amount NUMBER(10,2) NOT NULL,
     created_at TIMESTAMP DEFAULT SYSTIMESTAMP)`,
  `CREATE INDEX orders_customer_idx ON orders (customer_id)`,
  `COMMENT ON TABLE customers IS 'Customer master data'`,
  `CREATE VIEW order_totals AS SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name`,
  `INSERT INTO customers VALUES (1, 'Acme', 'DE')`,
  `INSERT INTO customers VALUES (2, 'Globex', 'US')`,
  `INSERT INTO customers VALUES (3, 'Initech', 'US')`,
  `INSERT INTO orders (id, customer_id, amount) SELECT level, 1 + MOD(level, 3), level * 1.5 FROM dual CONNECT BY level <= 300`,
  `BEGIN DBMS_STATS.GATHER_SCHEMA_STATS('${SALES.user}'); END;`,
  `GRANT SELECT ON customers TO ${READER.user}`,
];

const HR_DDL = [
  `CREATE TABLE employees (id NUMBER PRIMARY KEY, name VARCHAR2(80), department VARCHAR2(40))`,
  `INSERT INTO employees VALUES (1, 'Ann', 'IT')`,
  `INSERT INTO employees VALUES (2, 'Ben', 'Sales')`,
];

describe.skipIf(!HOST)("Oracle integration (sample schemas)", () => {
  beforeAll(async () => {
    initDriver();
    await dropAll();
    await runSql(ADMIN, [
      ...createUser(SALES, "CREATE SESSION, CREATE TABLE, CREATE VIEW"),
      ...createUser(HR, "CREATE SESSION, CREATE TABLE"),
      `CREATE USER ${READER.user} IDENTIFIED BY "${READER.password}"`,
      `GRANT CREATE SESSION TO ${READER.user}`,
    ]);
    await runSql(HR, HR_DDL);
    await runSql(SALES, SALES_DDL.slice(0, -1)); // GRANT to READER needs the user (created above)
    await runSql(ADMIN, [`BEGIN DBMS_STATS.GATHER_SCHEMA_STATS('${SALES.user}'); END;`]);
    await runSql(SALES, SALES_DDL.slice(-1));
  }, 120_000);

  afterAll(async () => {
    await closeAllPools();
    await dropAll();
  }, 120_000);

  // ── 1. All tools against the sales schema ───────────────────────────────────
  describe("MCP tools", () => {
    let client: Client; let server: ReturnType<typeof createMcpServer>;
    let admin: Client; let adminServer: ReturnType<typeof createMcpServer>;

    async function connectClient(c: Client, s: ReturnType<typeof createMcpServer>) {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([s.connect(a), c.connect(b)]);
    }

    beforeAll(async () => {
      const perf = { perf: true, diagnostics: false, tuning: false };
      server = createMcpServer(() => getPool(conn(SALES)), "tools-test", "127.0.0.1", perf);
      client = new Client({ name: "it", version: "1" });
      await connectClient(client, server);
      adminServer = createMcpServer(() => getPool(conn(ADMIN)), "admin-test", "127.0.0.1", perf);
      admin = new Client({ name: "it-admin", version: "1" });
      await connectClient(admin, adminServer);
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterAll(async () => { await client.close(); await admin.close(); vi.restoreAllMocks(); });

    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const callAdmin = (name: string, args: Record<string, unknown> = {}) => admin.callTool({ name, arguments: args });

    it("lists the base tools and the unlicensed performance tools", async () => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toEqual(expect.arrayContaining([
        "query", "execute", "list_tables", "describe_table", "list_schemas", "test_connection",
        "explain_plan", "top_sql", "session_activity", "table_stats", "db_overview", "locks",
      ]));
      expect(names).not.toContain("ash_top");      // Diagnostics Pack off
      expect(names).not.toContain("sql_monitor");  // Tuning Pack off
    });

    it("test_connection reports database and user", async () => {
      const t = text(await call("test_connection"));
      expect(t).toContain("✅ Connection successful!");
      expect(t.match(/^Service +: (\S+)/m)![1].toUpperCase()).toBe(SERVICE.toUpperCase());
      expect(t).toContain(`User       : ${SALES.user} (schema ${SALES.user})`);
      expect(t).toMatch(/^Transport +: .*tcp/im);
    });

    it("list_schemas / list_tables / describe_table", async () => {
      const schemas = text(await call("list_schemas"));
      expect(schemas).toContain(SALES.user);
      expect(schemas).toContain(HR.user);
      expect(schemas).not.toMatch(/^SYS$/m);
      expect(text(await call("list_schemas", { include_system: true }))).toMatch(/^SYS$/m);

      const tables = text(await call("list_tables"));
      expect(tables).toContain("TABLE: CUSTOMERS");
      expect(tables).toContain("TABLE: ORDERS");
      expect(tables).toContain("VIEW: ORDER_TOTALS");
      expect(text(await call("list_tables", { schema: SALES.user }))).toContain(`Tables in "${SALES.user}":`);
      expect(text(await call("list_tables", { schema: HR.user }))).toBe(`No tables in schema "${HR.user}".`); // not visible to MCPT_SALES

      const d = text(await call("describe_table", { table: "customers" }));
      expect(d).toMatch(/^ID \| NUMBER \| NO \|.*\| PK/m);
      expect(d).toContain("NAME | VARCHAR2(80 CHAR) | NO");
      expect(text(await call("describe_table", { table: "nope" }))).toContain("not found");
    });

    it("query: results, bind variables (array and named), empty result, views", async () => {
      expect(text(await call("query", { sql: "SELECT COUNT(*) AS n FROM orders" }))).toContain("300");
      const r = text(await call("query", { sql: "SELECT name FROM customers WHERE country = :1 ORDER BY name", params: ["US"] }));
      expect(r).toContain("Globex");
      expect(r).toContain("Initech");
      expect(r).not.toContain("Acme");
      const named = text(await call("query", { sql: "SELECT name FROM customers WHERE id = :id", params: { id: 1 } }));
      expect(named).toContain("Acme");
      expect(text(await call("query", { sql: "SELECT 1 FROM dual WHERE 1 = 0" }))).toBe("Query returned 0 rows.");
      expect(text(await call("query", { sql: "SELECT * FROM order_totals ORDER BY name;" }))).toContain("Acme");
    });

    it("query is read-only", async () => {
      const w = await call("query", { sql: "DELETE FROM orders" });
      expect(w.isError).toBe(true);
      expect(text(w)).toMatch(/only accepts SELECT or WITH/);
      const ddl = await call("query", { sql: "DROP TABLE orders" });
      expect(ddl.isError).toBe(true);
      const multi = await call("query", { sql: "SELECT 1 FROM dual; DELETE FROM orders" });
      expect(multi.isError).toBe(true);
      const forUpdate = await call("query", { sql: "SELECT * FROM customers FOR UPDATE" });
      expect(forUpdate.isError).toBe(true); // runs in SET TRANSACTION READ ONLY
      expect(text(forUpdate)).toMatch(/ORA-01456/);
      expect(text(await call("query", { sql: "SELECT COUNT(*) AS n FROM orders" }))).toContain("300");
    });

    it("execute commits DML, returns DBMS_OUTPUT and reports errors", async () => {
      expect(text(await call("execute", { sql: "INSERT INTO customers VALUES (:1, :2, :3)", params: [99, "Umbrella", "UK"] })))
        .toContain("Rows affected: 1");
      expect(text(await call("query", { sql: "SELECT country FROM customers WHERE name = 'Umbrella'" }))).toContain("UK"); // committed
      const bad = await call("execute", { sql: "INSERT INTO orders (id, customer_id, amount) VALUES (9999, 12345, 1)" });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/ORA-02291/);
      expect(text(await call("execute", { sql: "DELETE FROM customers WHERE id = 99" }))).toContain("Rows affected: 1");
      const pl = text(await call("execute", { sql: "BEGIN DBMS_OUTPUT.PUT_LINE('hello from plsql'); END;" }));
      expect(pl).toContain("DBMS_OUTPUT:\nhello from plsql");
    });

    it("DDL through execute is visible to query right away (ORA-01466 retry)", async () => {
      await call("execute", { sql: "CREATE TABLE fresh_t (id NUMBER)" });
      await call("execute", { sql: "INSERT INTO fresh_t VALUES (1)" });
      expect(text(await call("query", { sql: "SELECT COUNT(*) AS n FROM fresh_t" }))).toContain("1");
      expect((await call("execute", { sql: "DROP TABLE fresh_t PURGE" })).isError).toBeFalsy();
    });

    it("tool errors are reported, not thrown", async () => {
      const r = await call("query", { sql: "SELECT * FROM does_not_exist" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/ORA-00942/);
    });

    it("explain_plan, table_stats, session_activity, db_overview, locks, top_sql (as admin)", async () => {
      const plan = text(await callAdmin("explain_plan", { sql: `SELECT * FROM ${SALES.user}.orders WHERE customer_id = 1` }));
      expect(plan).toMatch(/Plan hash value/);
      expect(plan).toMatch(/ORDERS/);

      const stats = text(await callAdmin("table_stats", { schema: SALES.user, table: "orders" }));
      expect(stats).toContain("ORDERS");
      expect(stats).toContain("ORDERS_CUSTOMER_IDX");

      const sessions = await callAdmin("session_activity", { include_idle: true });
      expect(sessions.isError).toBeFalsy();
      expect(text(sessions)).toContain(SALES.user);

      const overview = await callAdmin("db_overview");
      expect(overview.isError).toBeFalsy();
      expect(text(overview)).toMatch(/Instance|instance/);

      const locks = await callAdmin("locks");
      expect(locks.isError).toBeFalsy();

      await call("query", { sql: "SELECT /* mcpt_marker */ COUNT(*) FROM orders" });
      const top = await callAdmin("top_sql", { sql_text_like: "mcpt_marker", include_system: false });
      expect(top.isError).toBeFalsy();
      expect(text(top)).toMatch(/mcpt_marker/i);
    });

    it("performance tools without privileges give a hint instead of a raw error", async () => {
      const r = await call("db_overview");
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/ORA-0(0942|1031)/);
      expect(text(r)).toMatch(/grant_perf_privileges\.sql|SELECT_CATALOG_ROLE/);
    });

    it("performance tools of the licensed packs are refused when the pack is off", async () => {
      const r = await callAdmin("ash_top");
      expect(r.isError).toBe(true);
    });
  });

  // ── 2. End to end over HTTP with OAuth ──────────────────────────────────────
  describe("HTTP + OAuth: group / e-mail decide the schema", () => {
    let srv: http.Server; let base: string; let dir: string; let idp: ReturnType<typeof makeIdp>;
    let realFetch: typeof fetch; let logs: string[]; const clients: Client[] = [];
    const saved: Record<string, string | undefined> = {};
    const ENV: Record<string, string> = {
      OAUTH_ISSUER: ISSUER, OAUTH_AUDIENCE: AUDIENCE, OAUTH_ADMIN_USERS: "root@example.com",
      OAUTH_PUBLIC_URL: "https://mcp.example.com",
      OAUTH_ASSIGNMENTS: JSON.stringify([
        { group: "grp-sales", connection: conn(SALES) },
        { group: "grp-hr", connection: conn(HR) },
        { user: "carol@example.com", connection: conn(SALES), client_connection: "credentials" },
      ]),
    };

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "oramcp-ora-"));
      srv = http.createServer(handleRequest);
      await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    });
    afterAll(async () => {
      await new Promise(r => srv.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(() => {
      for (const k of [...Object.keys(ENV), "AUTH_TOKEN", "TOKENS_FILE"]) saved[k] = process.env[k];
      Object.assign(process.env, ENV, { TOKENS_FILE: path.join(dir, "tokens.json") });
      delete process.env.AUTH_TOKEN;
      fs.rmSync(process.env.TOKENS_FILE as string, { force: true });
      clearOAuthCache(); clearTokenStoreCache();
      idp = makeIdp();
      realFetch = globalThis.fetch;
      // The fake provider answers for the issuer; everything else (MCP client -> server) uses the real fetch
      vi.stubGlobal("fetch", (u: string | URL, init?: RequestInit) => (String(u).startsWith(ISSUER) ? idp.fetch(u, init) : realFetch(u, init)));
      logs = [];
      vi.spyOn(console, "error").mockImplementation((m: unknown) => { logs.push(String(m)); });
    });
    afterEach(async () => {
      for (const c of clients.splice(0)) await c.close().catch(() => {});
      sessions.clear();
      vi.unstubAllGlobals(); vi.restoreAllMocks();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    async function open(claims: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Client> {
      const token = idp.sign(claims);
      const client = new Client({ name: "it", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    }
    const sql = async (client: Client, q: string) => text(await client.callTool({ name: "query", arguments: { sql: q } }));
    const WHO = `SELECT SYS_CONTEXT('USERENV','SESSION_USER') AS usr, SYS_CONTEXT('USERENV','MODULE') AS module,
      SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER') AS cid, SYS_CONTEXT('USERENV','ACTION') AS act FROM dual`;
    const api = (token: string, method: string, url: string, body?: unknown) => realFetch(`${base}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    it("the group decides the schema; MODULE / CLIENT_IDENTIFIER carry the user's e-mail", async () => {
      const alice = await open({ email: "alice@example.com", oid: "oid-alice", groups: ["grp-sales"] });
      const a = await sql(alice, WHO);
      expect(a).toContain(SALES.user);
      expect(a).toContain("alice@example.com");
      expect(a).toContain("oracle-mcp-server");
      expect(a).toContain("query"); // ACTION = tool
      expect(await sql(alice, "SELECT COUNT(*) AS n FROM orders")).toContain("300");

      const bob = await open({ email: "bob@example.com", oid: "oid-bob", groups: ["grp-hr"] });
      const b = await sql(bob, WHO);
      expect(b).toContain(HR.user);
      expect(b).toContain("bob@example.com");
      expect(await sql(bob, "SELECT name FROM employees ORDER BY id")).toContain("Ann");
      expect((await bob.callTool({ name: "query", arguments: { sql: "SELECT * FROM orders" } })).isError).toBe(true); // other schema
    });

    it("both users are visible in V$SESSION at the same time", async () => {
      const alice = await open({ email: "alice@example.com", groups: ["grp-sales"] });
      const bob = await open({ email: "bob@example.com", groups: ["grp-hr"] });
      await sql(alice, "SELECT 1 FROM dual");
      await sql(bob, "SELECT 1 FROM dual");
      const c = await oracledb.getConnection({ user: ADMIN.user, password: ADMIN.password, connectString: `${HOST}:${PORT}/${SERVICE}` });
      try {
        const { rows } = await c.execute<[string, string, string]>(
          `SELECT client_identifier, username, module FROM v$session WHERE client_identifier LIKE '%@example.com' ORDER BY 1`);
        const byUser = Object.fromEntries((rows ?? []).map(r => [r[0], r]));
        expect(byUser["alice@example.com"]?.[1]).toBe(SALES.user);
        expect(byUser["bob@example.com"]?.[1]).toBe(HR.user);
        expect(byUser["alice@example.com"]?.[2]).toBe("oracle-mcp-server");
      } finally { await c.close(); }
    });

    it("a user assignment beats the group assignment and may send own credentials (X-Oracle-*)", async () => {
      const claims = { email: "carol@example.com", oid: "oid-carol", groups: ["grp-hr"] }; // group says hr, user says sales
      const carol = await open(claims);
      expect(await sql(carol, WHO)).toContain(SALES.user);

      const reader = await open(claims, { "X-Oracle-User": READER.user, "X-Oracle-Password": READER.password });
      const r = await sql(reader, WHO);
      expect(r).toContain(READER.user);
      expect(r).toContain("carol@example.com");
      expect(await sql(reader, `SELECT COUNT(*) AS n FROM ${SALES.user}.customers`)).toContain("3");
      const w = await reader.callTool({ name: "execute", arguments: { sql: `DELETE FROM ${SALES.user}.customers` } });
      expect(w.isError).toBe(true);
      expect(text(w)).toMatch(/ORA-(01031|00942|41900)|privilege/i);
    });

    it("wrong client credentials fail in Oracle, not silently", async () => {
      const bad = await open({ email: "carol@example.com", groups: [] }, { "X-Oracle-User": READER.user, "X-Oracle-Password": "wrong" });
      const r = await bad.callTool({ name: "query", arguments: { sql: "SELECT 1 FROM dual" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/ORA-01017|invalid credential/i);
    });

    it("client connection headers are refused for assignments with client_connection=none", async () => {
      await expect(open({ email: "alice@example.com", groups: ["grp-sales"] }, { "X-Oracle-User": READER.user, "X-Oracle-Password": READER.password }))
        .rejects.toThrow();
      expect(logs.join("\n")).toMatch(/reason="client connection: This token does not allow/);
    });

    it("a valid token without assignment is refused and logged", async () => {
      await expect(open({ email: "dave@example.com", groups: ["grp-other"] })).rejects.toThrow();
      expect(logs.join("\n")).toMatch(/\[AUTH\] result="denied" token="dave@example\.com"[^\n]*oauth: no assignment/);
    });

    it("audits the MCP session and logs the tool calls with the user's e-mail", async () => {
      const alice = await open({ email: "alice@example.com", oid: "oid-alice", groups: ["grp-sales"] });
      await sql(alice, "SELECT 1 FROM dual");
      const all = logs.join("\n");
      expect(all).toMatch(/\[INFO\] \[AUDIT\] user="alice@example\.com" sub="oid-alice" action="session_start" session="[\w-]+" via="oauth"/);
      expect(all).toMatch(/\[SESSION\] token="alice@example\.com" action="start"/);
      expect(all).toMatch(/\[MCP\] token="alice@example\.com" action="query"/);
    });

    it("the 401 challenge points MCP clients to the protected resource metadata", async () => {
      const res = await realFetch(`${base}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"');
      const meta = await (await realFetch(`${base}/.well-known/oauth-protected-resource`)).json() as any;
      expect(meta).toMatchObject({ resource: "https://mcp.example.com/mcp", authorization_servers: [ISSUER] });
    });

    it("admin API: admins manage assignments, which apply to the next MCP session", async () => {
      const root = idp.sign({ email: "root@example.com", oid: "oid-root", groups: [] });
      const user = idp.sign({ email: "alice@example.com", groups: ["grp-sales"] });
      expect((await api(user, "GET", "/admin/assignments")).status).toBe(403);
      expect((await api(root, "GET", "/admin/assignments")).status).toBe(200);

      const eve = { email: "eve@example.com", oid: "oid-eve", groups: ["grp-eve"] };
      await expect(open(eve)).rejects.toThrow(); // no assignment yet

      const created = await api(root, "POST", "/admin/assignments", { group: "grp-eve", connection: conn(HR) });
      expect(created.status).toBe(201);
      const body = await created.json() as any;
      expect(JSON.stringify(body)).not.toContain(HR.password); // secrets never leave the server
      expect(body.connection).toMatchObject({ user: HR.user, password_set: true });

      expect(await sql(await open(eve), WHO)).toContain(HR.user);

      expect((await api(root, "DELETE", `/admin/assignments/${body.id}`)).status).toBe(200);
      await expect(open(eve)).rejects.toThrow();
      expect(logs.join("\n")).toMatch(/\[AUDIT\] user="root@example\.com" sub="oid-root" action="POST \/admin\/assignments"[^\n]*via="oauth-admin"/);
    });
  });
});
