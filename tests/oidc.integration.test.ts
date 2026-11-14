/**
 * Integration test against a real OIDC provider container, no mocks for fetch or crypto. Two providers work:
 *
 *   docker compose --profile oidc up -d oidc-test            # mock-oauth2-server (fast, no login screen)
 *   OIDC_TEST_ISSUER=http://localhost:8080/default npx vitest run tests/oidc.integration.test.ts
 *
 *   docker compose --profile keycloak up -d --wait keycloak  # Keycloak (admin console + real login form)
 *   OIDC_TEST_ISSUER=http://localhost:8081/realms/oracle-mcp npx vitest run tests/oidc.integration.test.ts
 *
 * Skipped unless OIDC_TEST_ISSUER is set; an issuer with "/realms/" is treated as Keycloak. The users alice
 * (grp-dba), bob (grp-users), eve (grp-other) and root (grp-admin) are defined in tests/oidc/mock-oauth2-config.json
 * and tests/oidc/keycloak-realm.json (Keycloak: password = user name).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { checkAuth, authenticateAdmin, clearTokenStoreCache } from "../src/lib.js";
import { handleOAuthRoute } from "../src/oauth-routes.js";
import { clearOAuthCache } from "../src/oauth.js";
import { makeReq, makeRes, resBody } from "./helpers.js";

const ISSUER = process.env.OIDC_TEST_ISSUER as string;
const KEYCLOAK = !!ISSUER && ISSUER.includes("/realms/");

/** Access token for a user defined in the mock provider (client credentials grant, `scope` selects the user). */
async function tokenFor(user: string): Promise<string> {
  // Keycloak: password grant of the public client oramcp-test; mock: client credentials, `scope` selects the user
  const res = KEYCLOAK
    ? await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "password", client_id: "oramcp-test", username: user, password: user }),
    })
    : await fetch(`${ISSUER}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "oracle-mcp-test", client_secret: "x", scope: user }),
    });
  expect(res.ok, await res.clone().text()).toBe(true);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Follows the authorization URL to the redirect back to us: the mock redirects at once, Keycloak shows a login form. */
async function authorizeAs(authorizeUrl: string, user: string): Promise<URL> {
  const first = await fetch(authorizeUrl, { redirect: "manual" });
  if (!KEYCLOAK) {
    expect(first.status).toBe(302);
    return new URL(first.headers.get("location") as string);
  }
  expect(first.status).toBe(200);
  const cookie = first.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const html = await first.text();
  const action = /<form[^>]*\saction="([^"]+)"/.exec(html)?.[1].replaceAll("&amp;", "&");
  expect(action, "Keycloak login form").toBeTruthy();
  const post = await fetch(action as string, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user, password: user, credentialId: "" }),
  });
  expect(post.status).toBe(302);
  return new URL(post.headers.get("location") as string);
}

describe.skipIf(!ISSUER)(`OIDC integration (${KEYCLOAK ? "Keycloak" : "mock-oauth2-server"})`, () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV: Record<string, string> = {
    OAUTH_ISSUER: ISSUER, OAUTH_AUDIENCE: "api://oracle-mcp", OAUTH_CLIENT_ID: "oramcp-web",
    ...(KEYCLOAK ? { OAUTH_CLIENT_SECRET: "oramcp-web-secret" } : {}),
    OAUTH_PUBLIC_URL: "http://localhost:3000", OAUTH_ADMIN_GROUPS: "grp-admin",
    OAUTH_ASSIGNMENTS: JSON.stringify([
      { group: "grp-dba", connection: { host: "dba-db", service_name: "PROD", user: "dba" }, client_connection: "credentials" },
      { user: "bob@example.com", connection: { host: "bob-db" } },
      { group: "grp-users" },
    ]),
  };

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oramcp-oidc-")); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => {
    for (const k of [...Object.keys(ENV), "OAUTH_CLIENT_SECRET", "AUTH_TOKEN", "TOKENS_FILE"]) saved[k] = process.env[k];
    Object.assign(process.env, ENV, { TOKENS_FILE: path.join(dir, "tokens.json") });
    delete process.env.AUTH_TOKEN;
    clearOAuthCache(); clearTokenStoreCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
  });

  const mcp = async (user: string) => {
    const res = makeRes();
    const auth = await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${await tokenFor(user)}` } }), res);
    return { auth, res };
  };
  const errorLog = () => vi.mocked(console.error).mock.calls.map(c => c[0]).join("\n");

  it("group of the user decides the default connection", async () => {
    const { auth } = await mcp("alice");
    expect(auth).toMatchObject({ ok: true, name: "alice@example.com", connection: { host: "dba-db", service_name: "PROD" }, clientConnection: "credentials" });
    expect((auth as any).identity).toMatchObject({ sub: "oid-alice", email: "alice@example.com", name: "Alice DBA" });
  });

  it("the user's e-mail assignment beats the group assignment", async () => {
    const { auth } = await mcp("bob");
    expect(auth).toMatchObject({ ok: true, connection: { host: "bob-db" } });
  });

  it("denies a valid token of a user without assignment", async () => {
    const { auth, res } = await mcp("eve");
    expect(auth).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(errorLog()).toMatch(/\[WARN\] \[AUTH\] result="denied" token="eve@example\.com"/);
  });

  it("rejects a token from this provider for another audience", async () => {
    process.env.OAUTH_AUDIENCE = "api://somebody-else";
    const { auth, res } = await mcp("alice");
    expect(auth).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("rejects a token with a manipulated payload (signature checked against the provider's JWKS)", async () => {
    const [h, p, s] = (await tokenFor("eve")).split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.groups = ["grp-admin"];
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    const res = makeRes();
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${forged}` } }), res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("admin API: only members of the admin group", async () => {
    const asAdmin = await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: `Bearer ${await tokenFor("root")}` } }), makeRes());
    expect(asAdmin).toMatchObject({ ok: true, name: "root@example.com", method: "oauth" });
    const res = makeRes();
    const asUser = await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: `Bearer ${await tokenFor("alice")}` } }), res);
    expect(asUser).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("browser login: authorization code flow with PKCE creates an admin session", async () => {
    const route = async (url: string, headers: Record<string, string> = {}) => {
      const res = makeRes();
      await handleOAuthRoute(makeReq("GET", url, { headers: { authorization: "", ...headers } }), res);
      return res;
    };
    // 1. our /auth/login redirects to the provider
    const login = await route("/auth/login");
    const authorizeUrl = login.writeHead.mock.calls[0][1].Location as string;
    expect(authorizeUrl.startsWith(KEYCLOAK ? `${ISSUER}/protocol/openid-connect/auth?` : `${ISSUER}/authorize?`)).toBe(true);
    // 2. the provider redirects back with code and state (Keycloak: after the login form)
    const back = await authorizeAs(authorizeUrl, "root");
    expect(back.pathname).toBe("/auth/callback");
    // 3. our callback exchanges the code, validates the id_token and sets the session cookie
    const cb = await route(`${back.pathname}${back.search}`);
    expect(cb.writeHead.mock.calls[0][0]).toBe(302);
    const cookie = (cb.writeHead.mock.calls[0][1]["Set-Cookie"] as string).split(";")[0];
    const status = resBody(await route("/auth/status", { cookie }));
    expect(status).toMatchObject({ authenticated: true, admin: true, user: { email: "root@example.com" } });
    expect(await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: "", cookie } }), makeRes())).toMatchObject({ ok: true });
  });

  it.skipIf(!KEYCLOAK)("Keycloak: browser login with a wrong password does not create a session", async () => {
    const res = makeRes();
    await handleOAuthRoute(makeReq("GET", "/auth/login", { headers: { authorization: "" } }), res);
    const authorizeUrl = res.writeHead.mock.calls[0][1].Location as string;
    const first = await fetch(authorizeUrl, { redirect: "manual" });
    const cookie = first.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const action = /<form[^>]*\saction="([^"]+)"/.exec(await first.text())?.[1].replaceAll("&amp;", "&") as string;
    const post = await fetch(action, {
      method: "POST", redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "wrong", credentialId: "" }),
    });
    expect(post.status).toBe(200); // login form again, no redirect with a code
    expect(post.headers.get("location")).toBeNull();
  });

  it.skipIf(!KEYCLOAK)("Keycloak: e-mails are verified, so OAUTH_REQUIRE_VERIFIED_EMAIL=true still matches", async () => {
    process.env.OAUTH_REQUIRE_VERIFIED_EMAIL = "true";
    try {
      const { auth } = await mcp("alice");
      expect(auth).toMatchObject({ ok: true, name: "alice@example.com" });
    } finally { delete process.env.OAUTH_REQUIRE_VERIFIED_EMAIL; }
  });

  describe.skipIf(!KEYCLOAK)("Keycloak: pre-registered MCP client does its own OAuth login (Claude Code: --client-id oramcp-mcp-client)", () => {
    const REDIRECT = "http://localhost:8765/callback";

    /** What an MCP client does: authorization code + PKCE at the provider, then the code exchange. */
    async function clientLogin(user: string, scope: string): Promise<string> {
      const verifier = crypto.randomBytes(32).toString("base64url");
      const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
      url.search = new URLSearchParams({
        client_id: "oramcp-mcp-client", response_type: "code", redirect_uri: REDIRECT, scope, state: "s1",
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      }).toString();
      const back = await authorizeAs(url.toString(), user);
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code", code: back.searchParams.get("code") as string,
          redirect_uri: REDIRECT, client_id: "oramcp-mcp-client", code_verifier: verifier,
        }),
      });
      expect(res.ok, await res.clone().text()).toBe(true);
      return ((await res.json()) as { access_token: string }).access_token;
    }
    const use = (token: string) => {
      const res = makeRes();
      return checkAuth(makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${token}` } }), res).then(auth => ({ auth, res }));
    };

    it("the token of the pre-registered client has audience and groups and is accepted by the server", async () => {
      const token = await clientLogin("alice", "openid profile email");
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      expect(claims.aud).toContain("api://oracle-mcp");
      expect(claims.groups).toEqual(["grp-dba"]);
      expect(claims.azp).toBe("oramcp-mcp-client");
      const { auth } = await use(token);
      expect(auth).toMatchObject({ ok: true, name: "alice@example.com", connection: { host: "dba-db" } });
    });

    it("a user without assignment is refused with 403 although the login at the provider succeeded", async () => {
      const { auth, res } = await use(await clientLogin("eve", "openid profile email"));
      expect(auth).toEqual({ ok: false });
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    it("the metadata tells clients which scope to request", async () => {
      process.env.OAUTH_RESOURCE_SCOPES = "openid profile email";
      try {
        const res = makeRes();
        await handleOAuthRoute(makeReq("GET", "/.well-known/oauth-protected-resource", { headers: { authorization: "" } }), res);
        expect(resBody(res)).toMatchObject({ authorization_servers: [ISSUER], scopes_supported: ["openid", "profile", "email"] });
      } finally { delete process.env.OAUTH_RESOURCE_SCOPES; }
    });
  });
});
