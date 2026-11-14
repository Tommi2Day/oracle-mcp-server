import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkAuth, authenticateAdmin, handleAdminRequest, clearTokenStoreCache, loadTokenStore, migrateTokenStore, hashToken, audit, send401 } from "../src/lib.js";
import { handleOAuthRoute } from "../src/oauth-routes.js";
import { clearOAuthCache, createSession, getOAuthConfig } from "../src/oauth.js";
import { makeReq, makeRes, resBody } from "./helpers.js";
import { makeIdp, setOAuthEnv, CLIENT_ID } from "./oidc-helpers.js";

const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({ mockReadFile: vi.fn(), mockWriteFile: vi.fn() }));
vi.mock("node:fs", () => ({ default: { readFileSync: mockReadFile, writeFileSync: mockWriteFile } }));

let idp: ReturnType<typeof makeIdp>; let restore: () => void; let logSpy: any; let store: any;
const lines = (): string[] => logSpy.mock.calls.map((c: any[]) => c[0]);
const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${idp.sign(claims)}` });
const alice = { email: "alice@x.com", oid: "oid-alice", groups: ["grp-dba"] };

beforeEach(() => {
  clearTokenStoreCache(); clearOAuthCache();
  idp = makeIdp();
  vi.stubGlobal("fetch", idp.fetch);
  restore = setOAuthEnv({ OAUTH_ALLOWED_GROUPS: "grp-users" });
  delete process.env.AUTH_TOKEN;
  store = { tokens: [], next_id: 1 };
  mockReadFile.mockImplementation(() => JSON.stringify(store));
  mockWriteFile.mockImplementation((_f: string, data: string) => { store = JSON.parse(data); });
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.AUTH_TOKEN; delete process.env.STORE_ENCRYPTION_KEY;
});

describe("checkAuth with OAuth", () => {
  it("is not disabled just because AUTH_TOKEN is empty", async () => {
    const res = makeRes();
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "" } }), res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("accepts a user of an allowed group and returns the server default connection", async () => {
    const r = await checkAuth(makeReq("POST", "/mcp", { headers: bearer({ email: "bob@x.com", oid: "o2", groups: ["grp-users"] }) }), makeRes());
    expect(r).toMatchObject({ ok: true, name: "bob@x.com", connection: null, clientConnection: "none" });
    expect((r as any).identity).toMatchObject({ sub: "o2", email: "bob@x.com", admin: false });
  });

  it("routes the user by group to the group's connection (stored assignment)", async () => {
    store.assignments = [{ id: 1, group: "grp-dba", connection: { host: "dba-db", service_name: "PROD" }, client_connection: "credentials" }];
    const r = await checkAuth(makeReq("POST", "/mcp", { headers: bearer(alice) }), makeRes());
    expect(r).toMatchObject({ ok: true, name: "alice@x.com", connection: { host: "dba-db", service_name: "PROD" }, clientConnection: "credentials" });
    expect((r as any).identity.assignment).toBe("1");
  });

  it("user e-mail assignment beats the group assignment; env assignments are read too", async () => {
    process.env.OAUTH_ASSIGNMENTS = JSON.stringify([{ user: "alice@x.com", connection: { host: "alice-db" } }]);
    store.assignments = [{ id: 1, group: "grp-dba", connection: { host: "dba-db" } }];
    const r = await checkAuth(makeReq("POST", "/mcp", { headers: bearer(alice) }), makeRes());
    expect((r as any).connection.host).toBe("alice-db");
    expect((r as any).identity.assignment).toBe("env-1");
  });

  it("denies (403, logged) an authenticated user without assignment", async () => {
    const res = makeRes();
    const r = await checkAuth(makeReq("POST", "/mcp", { headers: bearer({ email: "eve@x.com", groups: ["other"] }) }), res);
    expect(r).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(lines().join("\n")).toMatch(/\[WARN\] \[AUTH\] result="denied" token="eve@x.com" action="POST \/mcp" ip="[^"]*" reason="oauth: no assignment/);
  });

  it("mentions Entra group overage in the denial log", async () => {
    await checkAuth(makeReq("POST", "/mcp", { headers: bearer({ email: "eve@x.com", _claim_names: { groups: "src1" } }) }), makeRes());
    expect(lines().join("\n")).toMatch(/too many groups/);
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["wrong audience", { aud: "other" }],
  ])("rejects a %s token with 401 and logs the reason, never the token", async (_n: string, claims: Record<string, unknown>) => {
    const headers = bearer({ ...alice, ...claims });
    const res = makeRes();
    expect(await checkAuth(makeReq("POST", "/mcp", { headers }), res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(lines().join("\n")).toMatch(/reason="oauth: /);
    expect(lines().join("\n")).not.toContain(headers.authorization.slice(7));
  });

  it("advertises the protected resource metadata in the 401 challenge", () => {
    const res = makeRes();
    send401(res);
    expect(res.writeHead.mock.calls[0][1]["WWW-Authenticate"])
      .toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"');
  });

  it("still accepts AUTH_TOKEN and file tokens next to OAuth", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    store.tokens = [{ id: 1, name: "ci", token_hash: hashToken("file-token"), active: true, connection: null }];
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "Bearer admin-secret" } }), makeRes())).toMatchObject({ name: "admin" });
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "Bearer file-token" } }), makeRes())).toMatchObject({ name: "ci" });
  });

  it("does not send a JWT to the file-token path when OAuth is off", async () => {
    restore(); restore = setOAuthEnv(); delete process.env.OAUTH_ISSUER;
    process.env.AUTH_TOKEN = "admin-secret";
    const res = makeRes();
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: bearer(alice) }), res)).toEqual({ ok: false });
    expect(lines().join("\n")).toMatch(/reason="unknown token"/);
  });
});

describe("authenticateAdmin with OAuth", () => {
  beforeEach(() => { process.env.OAUTH_ADMIN_GROUPS = "grp-admin"; });
  const adminClaims = { email: "root@x.com", oid: "oid-root", groups: ["grp-admin"] };

  it("accepts AUTH_TOKEN as break-glass", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    expect(await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer admin-secret" } }), makeRes()))
      .toMatchObject({ ok: true, name: "admin", method: "token" });
  });

  it("requires authentication even without AUTH_TOKEN", async () => {
    const res = makeRes();
    expect(await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: "" } }), res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("accepts a bearer JWT of an admin group member", async () => {
    expect(await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: bearer(adminClaims) }), makeRes()))
      .toMatchObject({ ok: true, name: "root@x.com", method: "oauth" });
  });

  it("answers 403 for a regular user", async () => {
    const res = makeRes();
    const r = await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: bearer({ email: "bob@x.com", groups: ["grp-users"] }) }), res);
    expect(r).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(lines().join("\n")).toMatch(/reason="oauth: not an admin"/);
  });

  describe("browser session cookie", () => {
    const cookieReq = (method: string, extra: Record<string, string> = {}) => {
      const sid = createSession(getOAuthConfig()!, { email: "root@x.com", sub: "oid-root", display: "root@x.com", groups: ["grp-admin"] } as any);
      return makeReq(method, "/admin/assignments", { headers: { authorization: "", cookie: `oramcp_session=${sid}`, ...extra } });
    };

    it("is accepted for GET", async () => {
      expect(await authenticateAdmin(cookieReq("GET"), makeRes())).toMatchObject({ ok: true, name: "root@x.com" });
    });

    it("changing requests need the X-Requested-With header (CSRF)", async () => {
      const res = makeRes();
      expect(await authenticateAdmin(cookieReq("POST"), res)).toEqual({ ok: false });
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      expect(await authenticateAdmin(cookieReq("POST", { "x-requested-with": "x" }), makeRes())).toMatchObject({ ok: true });
    });

    it("access is re-evaluated: a session of a user who lost the admin assignment is rejected", async () => {
      const req = cookieReq("GET");
      delete process.env.OAUTH_ADMIN_GROUPS;
      const res = makeRes();
      expect(await authenticateAdmin(req, res)).toEqual({ ok: false });
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    it("a forged cookie is rejected", async () => {
      const res = makeRes();
      const req = makeReq("GET", "/admin/tokens", { headers: { authorization: "", cookie: "oramcp_session=forged" } });
      expect(await authenticateAdmin(req, res)).toEqual({ ok: false });
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
  });
});

describe("admin API: assignments", () => {
  const admin = { authorization: "", "x-requested-with": "x" };
  const call = async (method: string, url: string, body?: unknown, token: Record<string, string> = { ...bearer({ email: "root@x.com", oid: "oid-root", groups: ["grp-admin"] }) }) => {
    const req = makeReq(method, url, { headers: { ...admin, ...token }, body: body === undefined ? "" : JSON.stringify(body) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    return { res, status: res.writeHead.mock.calls[0]?.[0], body: res.end.mock.calls[0]?.[0] && resBody(res) };
  };
  beforeEach(() => { process.env.OAUTH_ADMIN_GROUPS = "grp-admin"; });

  it("lists env assignments (read-only, password masked) before stored ones", async () => {
    process.env.OAUTH_ASSIGNMENTS = JSON.stringify([{ group: "g", connection: { host: "h", password: "pw" } }]);
    store.assignments = [{ id: 1, user: "u@x.com", connection: null }];
    const { status, body } = await call("GET", "/admin/assignments");
    expect(status).toBe(200);
    const ids = body.assignments.map((a: any) => a.id);
    expect(ids.slice(0, 1)).toEqual(["env-1"]);
    expect(ids).toContain(1);
    expect(JSON.stringify(body)).not.toContain("pw");
    expect(body.assignments.find((a: any) => a.id === 1).source).toBe("store");
  });

  it("creates, updates and deletes a stored assignment", async () => {
    const created = await call("POST", "/admin/assignments", { group: "grp-dba", connection: { host: "dba" }, client_connection: "credentials", admin: false });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 1, group: "grp-dba", connection: { host: "dba" }, client_connection: "credentials", source: "store" });
    expect(store.assignments).toHaveLength(1);
    expect(store.next_assignment_id).toBe(2);

    const upd = await call("PATCH", "/admin/assignments/1", { admin: true, client_connection: "none", connection: null });
    expect(upd.status).toBe(200);
    expect(store.assignments[0]).toMatchObject({ admin: true, connection: null });
    expect(store.assignments[0].client_connection).toBeUndefined();

    expect((await call("DELETE", "/admin/assignments/1")).status).toBe(200);
    expect(store.assignments).toEqual([]);
    expect((await call("DELETE", "/admin/assignments/1")).status).toBe(404);
  });

  it("a created assignment takes effect immediately for MCP requests", async () => {
    const eve = { email: "eve@x.com", groups: ["grp-eve"] };
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: bearer(eve) }), makeRes())).toEqual({ ok: false });
    await call("POST", "/admin/assignments", { group: "grp-eve", connection: { host: "eve-db" } });
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: bearer(eve) }), makeRes())).toMatchObject({ ok: true, connection: { host: "eve-db" } });
  });

  it.each([
    [{}, /exactly one/], [{ group: "a", user: "b" }, /exactly one/], [{ group: "a", client_connection: "bogus" }, /client_connection/],
    [{ group: "a", connection: [] }, /connection/],
  ])("rejects invalid body %j", async (body: any, msg: RegExp) => {
    const { status, body: b } = await call("POST", "/admin/assignments", body);
    expect(status).toBe(400);
    expect(b.error).toMatch(msg);
  });

  it("does not allow changing group/user or editing env assignments", async () => {
    await call("POST", "/admin/assignments", { group: "g" });
    expect((await call("PATCH", "/admin/assignments/1", { group: "other" })).status).toBe(400);
    expect((await call("PATCH", "/admin/assignments/env-1", { admin: true })).status).toBe(404);
    expect((await call("PATCH", "/admin/assignments/99", { admin: true })).status).toBe(404);
  });

  it("encrypts stored connection passwords like token passwords", async () => {
    process.env.STORE_ENCRYPTION_KEY = "k";
    await call("POST", "/admin/assignments", { group: "g", connection: { host: "h", password: "topsecret" } });
    const written = mockWriteFile.mock.calls.at(-1)![1];
    expect(written).not.toContain("topsecret");
    expect(written).toContain("enc:v1:");
    clearTokenStoreCache();
    mockReadFile.mockImplementation(() => written);
    const { body } = await call("GET", "/admin/assignments");
    const listed = body.assignments.find((a: any) => a.group === "g").connection;
    expect(listed).toEqual({ host: "h", password_set: true }); // secrets never leave the server
    expect(loadTokenStore().assignments![0].connection!.password).toBe("topsecret"); // decrypted for use
  });

  it("GET /admin/me describes the caller and the OAuth setup", async () => {
    const { status, body } = await call("GET", "/admin/me");
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "root@x.com", method: "oauth", email: "root@x.com", oauth: { groups_claim: "groups" } });
  });

  it("logs the acting user (ADMIN) and audits changes (AUDIT)", async () => {
    await call("POST", "/admin/assignments", { group: "g" });
    const text = lines().join("\n");
    expect(text).toMatch(/\[INFO\] \[ADMIN\] token="root@x\.com" action="POST \/admin\/assignments"/);
    expect(text).toMatch(/\[INFO\] \[AUDIT\] user="root@x\.com" sub="oid-root" action="POST \/admin\/assignments" ip="[^"]*" via="oauth-admin"/);
  });

  it("a regular user cannot manage assignments", async () => {
    const { status } = await call("POST", "/admin/assignments", { group: "g" }, bearer({ email: "bob@x.com", groups: ["grp-users"] }));
    expect(status).toBe(403);
    expect(store.assignments).toBeUndefined();
  });
});

describe("audit()", () => {
  it("writes sanitized key=value pairs at INFO, skipping empty values", () => {
    audit({ user: 'a"b@x.com', action: "login", empty: "", none: undefined });
    expect(lines()[0]).toMatch(/\[INFO\] \[AUDIT\] user="a\?b@x\.com" action="login"$/);
  });
});

describe("OAuth routes (browser login)", () => {
  const route = async (method: string, url: string, headers: Record<string, string> = {}) => {
    const req = makeReq(method, url, { headers: { authorization: "", ...headers } });
    const res = makeRes();
    const handled = await handleOAuthRoute(req, res);
    return { handled, res, status: res.writeHead.mock.calls[0]?.[0], headers: res.writeHead.mock.calls[0]?.[1] };
  };

  it("ignores other paths", async () => {
    expect((await route("GET", "/mcp")).handled).toBe(false);
  });

  it("/auth/status without OAuth", async () => {
    restore(); restore = setOAuthEnv(); delete process.env.OAUTH_ISSUER;
    const { res } = await route("GET", "/auth/status");
    expect(resBody(res)).toEqual({ enabled: false });
  });

  it("/auth/status shows login availability and the session", async () => {
    expect(resBody((await route("GET", "/auth/status")).res)).toEqual({ enabled: true, login: true, authenticated: false, user: null, admin: false });
    process.env.OAUTH_ADMIN_USERS = "root@x.com";
    const sid = createSession(getOAuthConfig()!, { email: "root@x.com", name: "Root", groups: [] } as any);
    const { res } = await route("GET", "/auth/status", { cookie: `oramcp_session=${sid}` });
    expect(resBody(res)).toMatchObject({ authenticated: true, admin: true, user: { email: "root@x.com", name: "Root" } });
  });

  it("/auth/login redirects to the identity provider; 404 without client id", async () => {
    const { status, headers } = await route("GET", "/auth/login");
    expect(status).toBe(302);
    expect(headers.Location).toContain("/authorize?");
    delete process.env.OAUTH_CLIENT_ID;
    expect((await route("GET", "/auth/login")).status).toBe(404);
  });

  it("/auth/login answers 502 when the provider is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    clearOAuthCache();
    expect((await route("GET", "/auth/login")).status).toBe(502);
  });

  async function loginFlow(claims: Record<string, unknown>) {
    const { headers } = await route("GET", "/auth/login");
    const q = new URL(headers.Location).searchParams;
    idp.tokenResponse = () => ({ ok: true, status: 200, json: async () => ({ id_token: idp.sign({ aud: CLIENT_ID, nonce: q.get("nonce"), ...claims }) }) });
    return route("GET", `/auth/callback?code=c1&state=${q.get("state")}`, { "x-real-ip": "192.0.2.5" });
  }

  it("callback creates the session cookie, redirects to /admin and audits the login", async () => {
    process.env.OAUTH_ADMIN_GROUPS = "grp-admin";
    const r = await loginFlow({ email: "root@x.com", oid: "oid-root", groups: ["grp-admin"] });
    expect(r.status).toBe(302);
    expect(r.headers.Location).toBe("/admin");
    expect(r.headers["Set-Cookie"]).toMatch(/^oramcp_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
    expect(lines().join("\n")).toMatch(/\[AUDIT\] user="root@x\.com" sub="oid-root" action="login" via="oauth-browser" admin="true" ip="192\.0\.2\.5"/);
    const cookie = r.headers["Set-Cookie"].split(";")[0];
    expect(resBody((await route("GET", "/auth/status", { cookie })).res)).toMatchObject({ authenticated: true, admin: true });
  });

  it("callback refuses users without assignment (no cookie)", async () => {
    const r = await loginFlow({ email: "eve@x.com", groups: ["nope"] });
    expect(r.status).toBe(403);
    expect(r.headers["Set-Cookie"]).toBeUndefined();
    expect(lines().join("\n")).toMatch(/\[WARN\] \[AUTH\] result="denied" token="eve@x\.com" action="GET \/auth\/callback"/);
  });

  it("callback rejects an unknown state and provider errors", async () => {
    expect((await route("GET", "/auth/callback?code=c&state=forged")).status).toBe(401);
    expect((await route("GET", "/auth/callback?error=access_denied")).status).toBe(401);
  });

  it("logout destroys the session, clears the cookie and audits", async () => {
    const sid = createSession(getOAuthConfig()!, { email: "a@x.com", sub: "s", display: "a@x.com", groups: [] } as any);
    const r = await route("POST", "/auth/logout", { cookie: `oramcp_session=${sid}` });
    expect(r.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
    expect(lines().join("\n")).toMatch(/\[AUDIT\] user="a@x\.com" sub="s" action="logout"/);
    expect(resBody((await route("GET", "/auth/status", { cookie: `oramcp_session=${sid}` })).res).authenticated).toBe(false);
    expect((await route("GET", "/auth/logout")).handled).toBe(false); // no logout by GET (CSRF)
  });

  it("serves RFC 9728 protected resource metadata", async () => {
    const { res } = await route("GET", "/.well-known/oauth-protected-resource");
    expect(resBody(res)).toMatchObject({
      resource: "https://mcp.test/mcp", authorization_servers: [expect.stringContaining("idp.test")],
      bearer_methods_supported: ["header"], scopes_supported: ["api://oracle-mcp/.default"],
    });
  });

  it("OAUTH_RESOURCE_SCOPES sets the advertised scopes (providers without api://…/.default, e.g. Keycloak)", async () => {
    process.env.OAUTH_RESOURCE_SCOPES = "oracle-mcp";
    const { res } = await route("GET", "/.well-known/oauth-protected-resource");
    expect(resBody(res).scopes_supported).toEqual(["oracle-mcp"]);
  });
});

describe("token store with assignments", () => {
  it("migrateTokenStore encrypts plaintext assignment passwords at startup", () => {
    process.env.STORE_ENCRYPTION_KEY = "k";
    store = {
      tokens: [], next_id: 1, next_assignment_id: 2,
      assignments: [{ id: 1, group: "g", connection: { host: "h", password: "pw-plain", wallet_password: "wpw-plain" } }],
    };
    migrateTokenStore();
    const written = mockWriteFile.mock.calls.at(-1)![1] as string;
    expect(written).not.toContain("pw-plain");
    expect(written).not.toContain("wpw-plain");
    expect(written).toContain("enc:v1:");
    expect(lines().join("\n")).toMatch(/\[STORE\] Encrypted 2 plaintext secret\(s\)/);
    clearTokenStoreCache();
    expect(loadTokenStore().assignments![0].connection).toMatchObject({ password: "pw-plain", wallet_password: "wpw-plain" });
  });

  it("is a no-op without STORE_ENCRYPTION_KEY", () => {
    store = { tokens: [], next_id: 1, assignments: [{ id: 1, group: "g", connection: { password: "p" } }] };
    migrateTokenStore();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
