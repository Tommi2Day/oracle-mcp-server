import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

/**
 * scripts/admincli.sh against a stub admin API: checks the requests the CLI sends (method, path, body, bearer
 * token) and its output. Skipped where bash or curl are missing.
 */
const SCRIPT = path.resolve(import.meta.dirname, "../scripts/admincli.sh").replace(/\\/g, "/");
const haveTools = ["bash", "curl"].every(c => spawnSync(c, ["--version"]).status === 0);

interface Seen { method: string; url: string; auth: string; body: string }
const seen: Seen[] = [];
let server: http.Server;
let base = "";

const ASSIGNMENTS = [
  { id: "env-1", group: "grp-dba", source: "env", connection: null },
  { id: 1, group: "grp-users", source: "store", connection: { host: "db", service_name: "REPORTS", user: "ro", password_set: true } },
  { id: 2, user: "alice@example.com", admin: true, client_connection: "credentials", source: "store", connection: null },
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "", body });
      const send = (status: number, obj: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/admin/me") return send(200, { name: "root@example.com", method: "oauth", email: "root@example.com", oauth: { issuer: "https://idp", groups_claim: "groups", session_ttl: 28800 } });
      if (req.url === "/admin/assignments" && req.method === "GET") return send(200, { assignments: ASSIGNMENTS });
      if (req.url === "/admin/assignments" && req.method === "POST") return send(201, { id: 7, ...JSON.parse(body) });
      if (req.url === "/admin/tokens" && req.method === "POST") return send(201, { id: 3, token: "tok-123", ...JSON.parse(body) });
      if (req.url === "/admin/assignments/9") return send(404, { error: "Not found" });
      if (req.url?.startsWith("/admin/assignments/")) return send(200, { ok: true });
      send(404, { error: "Not found" });
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

function cli(args: string[], env: Record<string, string> = { AUTH_TOKEN: "tok" }):
  Promise<{ code: number; out: string }> {
  seen.length = 0;
  return new Promise(resolve => {
    execFile("bash", [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", MCP_URL: base, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr });
    });
  });
}
const lastBody = () => JSON.parse(seen.at(-1)!.body);

describe.skipIf(!haveTools)("admincli.sh assignments", () => {
  it("whoami shows the identity", async () => {
    const r = await cli(["whoami"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("root@example.com");
    expect(seen[0]).toMatchObject({ method: "GET", url: "/admin/me", auth: "Bearer tok" });
  });

  it("accepts ADMIN_TOKEN (e.g. an OAuth access token) as alias", async () => {
    const r = await cli(["whoami"], { ADMIN_TOKEN: "jwt.value.here" });
    expect(r.code).toBe(0);
    expect(seen[0].auth).toBe("Bearer jwt.value.here");
  });

  it("refuses to run without a token", async () => {
    const r = await cli(["list-assignments"], {});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("AUTH_TOKEN not set");
    expect(seen).toHaveLength(0);
  });

  it("list-assignments shows environment and stored entries", async () => {
    const r = await cli(["list-assignments"]);
    expect(r.code).toBe(0);
    for (const s of ["grp-dba", "grp-users", "alice@example.com"]) expect(r.out).toContain(s);
  });

  it("show-assignment prints one entry, unknown id fails", async () => {
    const ok = await cli(["show-assignment", "2"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("alice@example.com");
    expect(ok.out).not.toContain("grp-users");
    expect((await cli(["show-assignment", "42"])).code).not.toBe(0);
  });

  it("add-assignment --group with a connection", async () => {
    const r = await cli(["add-assignment", "--group", "grp-dba", "--tns-alias", "PROD_HIGH", "--user", "dba", "--password", "p\"w",
      "--diagnostics-pack", "true", "--client-connection", "credentials", "--note", "DBAs"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ID: 7");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/admin/assignments" });
    expect(lastBody()).toEqual({
      group: "grp-dba", note: "DBAs", client_connection: "credentials",
      connection: { tns_alias: "PROD_HIGH", user: "dba", password: "p\"w", diagnostics_pack: true },
    });
  });

  it("add-assignment --email --admin without connection", async () => {
    const r = await cli(["add-assignment", "--email", "*@example.com", "--admin"]);
    expect(r.code).toBe(0);
    expect(lastBody()).toEqual({ user: "*@example.com", admin: true });
  });

  it("add-assignment host target", async () => {
    await cli(["add-assignment", "--group", "g", "--host", "db", "--port", "1522", "--service", "S", "--protocol", "tcps"]);
    expect(lastBody().connection).toEqual({ host: "db", port: 1522, service_name: "S", protocol: "tcps" });
  });

  it("add-assignment validates its arguments", async () => {
    for (const args of [[], ["--group", "a", "--email", "b"], ["--group", "a", "--client-connection", "bogus"], ["--group", "a", "--bogus"]]) {
      const r = await cli(["add-assignment", ...args]);
      expect(r.code, args.join(" ")).not.toBe(0);
    }
    expect(seen).toHaveLength(0);
  });

  it("add-token does not accept assignment options", async () => {
    const r = await cli(["add-token", "t", "--group", "g"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Unknown option: --group");
  });

  it("add-token still builds its request (shared option parsing)", async () => {
    const r = await cli(["add-token", "prod", "--tns-alias", "PROD", "--user", "app", "--password", "pw", "--client-connection", "full"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tok-123");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/admin/tokens" });
    expect(lastBody()).toEqual({ name: "prod", connection: { tns_alias: "PROD", user: "app", password: "pw" }, client_connection: "full" });
  });

  it("changes and deletes", async () => {
    expect((await cli(["delete-assignment", "1"])).code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/admin/assignments/1" });

    expect((await cli(["set-assignment-conn", "1", '{"tns_alias":"X"}'])).code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/admin/assignments/1" });
    expect(lastBody()).toEqual({ connection: { tns_alias: "X" } });

    await cli(["clear-assignment-conn", "1"]);
    expect(lastBody()).toEqual({ connection: null });

    await cli(["set-assignment-client-conn", "1", "full"]);
    expect(lastBody()).toEqual({ client_connection: "full" });

    await cli(["set-assignment-admin", "1", "true"]);
    expect(lastBody()).toEqual({ admin: true });

    expect((await cli(["set-assignment-client-conn", "1", "x"])).code).not.toBe(0);
    expect((await cli(["set-assignment-admin", "1", "maybe"])).code).not.toBe(0);
  });

  it("reports API errors", async () => {
    const r = await cli(["delete-assignment", "9"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("HTTP 404");
  });

  it("help lists the assignment commands", async () => {
    const r = await cli(["help"], {});
    for (const c of ["list-assignments", "add-assignment", "whoami", "set-assignment-admin"]) expect(r.out).toContain(c);
  });
});
