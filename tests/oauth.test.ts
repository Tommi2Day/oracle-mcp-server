import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getOAuthConfig, oauthConfigProblems, verifyJwt, identityFromClaims, envAssignments, resolveAccess,
  assignmentError, clearOAuthCache, startLogin, finishLogin, createSession, sessionFromRequest,
  destroySession, parseCookies, sessionCookie, looksLikeJwt, decodeJwt, safeLogValue, OAuthError,
} from "../src/oauth.js";
import { makeIdp, setOAuthEnv, ISSUER, AUDIENCE, CLIENT_ID } from "./oidc-helpers.js";

let idp: ReturnType<typeof makeIdp>; let restore: () => void;
beforeEach(() => {
  clearOAuthCache();
  idp = makeIdp();
  vi.stubGlobal("fetch", idp.fetch);
  restore = setOAuthEnv();
});
afterEach(() => { restore(); vi.unstubAllGlobals(); });

describe("getOAuthConfig", () => {
  it("is null without OAUTH_ISSUER", () => {
    delete process.env.OAUTH_ISSUER;
    expect(getOAuthConfig()).toBeNull();
    expect(oauthConfigProblems()).toEqual([]);
  });

  it("reads defaults and lists", () => {
    process.env.OAUTH_ISSUER = `${ISSUER}/`;
    process.env.OAUTH_ALLOWED_ISSUERS = "https://a/, https://b";
    delete process.env.OAUTH_AUDIENCE;
    const c = getOAuthConfig()!;
    expect(c.issuer).toBe(ISSUER);
    expect(c.issuers).toEqual(["https://a", "https://b"]);
    expect(c.audience).toEqual([CLIENT_ID]); // falls back to client id
    expect(c.redirectUri).toBe("https://mcp.test/auth/callback");
    expect(c.groupsClaim).toBe("groups");
    expect(c.sessionTtl).toBe(28800);
  });

  it("advertises <audience>/.default as resource scope unless OAUTH_RESOURCE_SCOPES is set (space or comma separated)", () => {
    expect(getOAuthConfig()!.resourceScopes).toEqual([`${AUDIENCE}/.default`]);
    process.env.OAUTH_AUDIENCE = "api://a, api://b";
    expect(getOAuthConfig()!.resourceScopes).toEqual(["api://a/.default", "api://b/.default"]);
    process.env.OAUTH_RESOURCE_SCOPES = "oracle-mcp  openid,profile";
    expect(getOAuthConfig()!.resourceScopes).toEqual(["oracle-mcp", "openid", "profile"]);
  });

  it("reports problems", () => {
    delete process.env.OAUTH_AUDIENCE; delete process.env.OAUTH_CLIENT_ID;
    expect(oauthConfigProblems()).toHaveLength(1);
    process.env.OAUTH_CLIENT_ID = "c"; delete process.env.OAUTH_PUBLIC_URL;
    expect(oauthConfigProblems()[0]).toMatch(/OAUTH_PUBLIC_URL/);
  });
});

describe("verifyJwt", () => {
  const cfg = () => getOAuthConfig()!;

  it("accepts a valid RS256 token and returns its claims", async () => {
    const claims = await verifyJwt(idp.sign({ email: "a@x.com" }), cfg());
    expect(claims).toMatchObject({ sub: "sub-1", email: "a@x.com" });
  });

  it("accepts PS256 and ES256 tokens", async () => {
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    idp.keys.push({ ...ec.publicKey.export({ format: "jwk" }), kid: "ec", use: "sig" });
    expect(await verifyJwt(idp.sign({}, { alg: "PS256" }), cfg())).toBeTruthy();
    expect(await verifyJwt(idp.sign({}, { alg: "ES256", kid: "ec", key: ec.privateKey }), cfg())).toBeTruthy();
  });

  it.each([
    ["alg none", (i: any) => i.sign({}, { alg: "none" }), /unsupported algorithm/],
    ["HS256", (i: any) => i.sign({}, { alg: "HS256" }), /unsupported algorithm/],
    ["expired", (i: any) => i.sign({ exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/],
    ["not yet valid", (i: any) => i.sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }), /not yet valid/],
    ["no exp", (i: any) => i.sign({ exp: undefined }), /no exp/],
    ["wrong issuer", (i: any) => i.sign({ iss: "https://evil" }), /issuer/],
    ["wrong audience", (i: any) => i.sign({ aud: "other" }), /audience/],
    ["unknown kid", (i: any) => i.sign({}, { kid: "nope" }), /signing key not found/],
    ["bad signature", (i: any) => i.sign({}, { key: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), /invalid signature/],
  ])("rejects %s", async (_n: string, make: any, msg: RegExp) => {
    await expect(verifyJwt(make(idp), cfg())).rejects.toThrow(msg);
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = idp.sign({ email: "a@x.com" }).split(".");
    const forged = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: 9999999999, email: "admin@x.com" })).toString("base64url");
    await expect(verifyJwt(`${h}.${forged}.${s}`, cfg())).rejects.toThrow(/invalid signature/);
  });

  it("accepts an audience list containing a configured audience", async () => {
    expect(await verifyJwt(idp.sign({ aud: ["x", AUDIENCE] }), cfg())).toBeTruthy();
  });

  it("checks the nonce when requested", async () => {
    const t = idp.sign({ nonce: "n1" });
    await expect(verifyJwt(t, cfg(), { nonce: "n2" })).rejects.toThrow(/nonce/);
    expect(await verifyJwt(t, cfg(), { nonce: "n1" })).toBeTruthy();
  });

  it("refreshes the key set once for an unknown kid (rotation) but not on every request", async () => {
    await verifyJwt(idp.sign(), cfg());
    expect(idp.hits.jwks).toBe(1);
    const next = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    idp.keys.push({ ...next.publicKey.export({ format: "jwk" }), kid: "k2", use: "sig" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      expect(await verifyJwt(idp.sign({}, { kid: "k2", key: next.privateKey }), cfg())).toBeTruthy();
      expect(idp.hits.jwks).toBe(2);
      await expect(verifyJwt(idp.sign({}, { kid: "zzz" }), cfg())).rejects.toThrow(/not found/);
      expect(idp.hits.jwks).toBe(2); // cooldown
    } finally { vi.useRealTimers(); }
  });

  it("caches the discovery document", async () => {
    await verifyJwt(idp.sign(), cfg());
    await verifyJwt(idp.sign(), cfg());
    expect(idp.hits.discovery).toBe(1);
  });

  it("reports an unreachable provider as OAuthError", async () => {
    clearOAuthCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(verifyJwt(idp.sign(), cfg())).rejects.toBeInstanceOf(OAuthError);
  });

  it("uses explicit endpoints without discovery", async () => {
    process.env.OAUTH_JWKS_URI = `${ISSUER}/keys`;
    process.env.OAUTH_AUTHORIZATION_ENDPOINT = `${ISSUER}/authorize`;
    process.env.OAUTH_TOKEN_ENDPOINT = `${ISSUER}/token`;
    await verifyJwt(idp.sign(), cfg());
    expect(idp.hits.discovery).toBe(0);
  });
});

describe("jwt helpers", () => {
  it("looksLikeJwt / decodeJwt", () => {
    expect(looksLikeJwt("a.b.c")).toBe(true);
    expect(looksLikeJwt("abcdef0123")).toBe(false);
    expect(looksLikeJwt("")).toBe(false);
    expect(() => decodeJwt("a.b.c")).toThrow(/malformed/);
    expect(() => decodeJwt("nope")).toThrow(/not a JWT/);
  });
  it("safeLogValue strips quotes, backslashes and control characters", () => {
    expect(safeLogValue('a"b\\c\nd')).toBe("a?b?c?d");
    expect(safeLogValue("x".repeat(500))).toHaveLength(128);
  });
});

describe("identityFromClaims", () => {
  const cfg = () => getOAuthConfig()!;
  it("takes e-mail (lower case) and groups (lower case)", () => {
    const id = identityFromClaims({ sub: "s", oid: "o1", email: "Alice@X.com", name: "Alice", groups: ["AAA", "bbb"] }, cfg());
    expect(id).toMatchObject({ sub: "o1", email: "alice@x.com", name: "Alice", display: "alice@x.com", groups: ["aaa", "bbb"] });
  });
  it("falls back to preferred_username, upn, then the subject", () => {
    expect(identityFromClaims({ preferred_username: "p@x.com" }, cfg()).email).toBe("p@x.com");
    expect(identityFromClaims({ upn: "u@x.com" }, cfg()).email).toBe("u@x.com");
    const id = identityFromClaims({ sub: "abc" }, cfg());
    expect(id.email).toBeNull();
    expect(id.display).toBe("abc");
  });
  it("honours OAUTH_EMAIL_CLAIM and a nested OAUTH_GROUPS_CLAIM", () => {
    process.env.OAUTH_EMAIL_CLAIM = "mail"; process.env.OAUTH_GROUPS_CLAIM = "realm_access.roles";
    const id = identityFromClaims({ mail: "m@x.com", email: "other@x.com", realm_access: { roles: ["Dba"] } }, getOAuthConfig()!);
    expect(id).toMatchObject({ email: "m@x.com", groups: ["dba"] });
  });
  it("accepts a single string as groups and flags Entra group overage", () => {
    expect(identityFromClaims({ groups: "g1" }, cfg()).groups).toEqual(["g1"]);
    expect(identityFromClaims({ _claim_names: { groups: "src1" } }, cfg())).toMatchObject({ groups: [], groupsOverage: true });
  });
  it("ignores an e-mail marked unverified; OAUTH_REQUIRE_VERIFIED_EMAIL also drops claims without email_verified", () => {
    expect(identityFromClaims({ sub: "s", email: "a@x.com", email_verified: false }, cfg()).email).toBeNull();
    expect(identityFromClaims({ sub: "s", email: "a@x.com", email_verified: true }, cfg()).email).toBe("a@x.com");
    process.env.OAUTH_REQUIRE_VERIFIED_EMAIL = "true";
    expect(identityFromClaims({ sub: "s", email: "a@x.com" }, getOAuthConfig()!).email).toBeNull();
    expect(identityFromClaims({ sub: "s", email: "a@x.com", email_verified: true }, getOAuthConfig()!).email).toBe("a@x.com");
  });
  it("sanitizes a hostile e-mail for logs", () => {
    expect(identityFromClaims({ email: 'x"y@z.com\nINFO' }, cfg()).display).not.toMatch(/["\n]/);
  });
});

describe("envAssignments", () => {
  it("builds assignments from the simple lists and OAUTH_ASSIGNMENTS", () => {
    process.env.OAUTH_ALLOWED_GROUPS = "g1, g2";
    process.env.OAUTH_ALLOWED_USERS = "u@x.com";
    process.env.OAUTH_ADMIN_GROUPS = "adm";
    process.env.OAUTH_ADMIN_USERS = "boss@x.com";
    process.env.OAUTH_ASSIGNMENTS = JSON.stringify([{ group: "dba", connection: { host: "h" }, client_connection: "credentials" }]);
    const list = envAssignments();
    expect(list.map(a => a.id)).toEqual(["env-1", "env-2", "env-3", "env-4", "env-5", "env-6"]);
    expect(list[0]).toMatchObject({ group: "dba", connection: { host: "h" }, source: "env" });
    expect(list.filter(a => a.admin).map(a => a.group || a.user)).toEqual(["adm", "boss@x.com"]);
    expect(list[1].connection).toBeNull();
  });
  it("is empty without configuration and rejects invalid JSON", () => {
    expect(envAssignments()).toEqual([]);
    process.env.OAUTH_ASSIGNMENTS = "{nope";
    expect(() => envAssignments()).toThrow(/not valid JSON/);
    process.env.OAUTH_ASSIGNMENTS = "{}";
    expect(() => envAssignments()).toThrow(/array/);
  });
});

describe("resolveAccess", () => {
  const id = (over: Record<string, unknown> = {}): any => ({ email: "alice@x.com", groups: ["g1", "g2"], ...over });
  const A = (a: any): any => ({ connection: null, ...a });

  it("denies when nothing matches (deny by default)", () => {
    expect(resolveAccess(id(), [])).toEqual({ allowed: false, admin: false });
    expect(resolveAccess(id(), [A({ id: 1, group: "other" }), A({ id: 2, user: "bob@x.com" })]).allowed).toBe(false);
  });

  it("allows by group (case-insensitive) with the server default connection when none is set", () => {
    const r = resolveAccess(id({ groups: ["g1"] }), [A({ id: 1, group: "G1" })]);
    expect(r).toMatchObject({ allowed: true, admin: false, connection: null, clientConnection: "none", assignment: "1" });
  });

  it("uses the group's connection", () => {
    const conn = { host: "team-a" };
    expect(resolveAccess(id(), [A({ id: 1, group: "g2", connection: conn, client_connection: "credentials" })]))
      .toMatchObject({ connection: conn, clientConnection: "credentials" });
  });

  it("user beats domain pattern beats group", () => {
    const list = [
      A({ id: "g", group: "g1", connection: { host: "group" } }),
      A({ id: "d", user: "*@x.com", connection: { host: "domain" } }),
      A({ id: "u", user: "Alice@X.com", connection: { host: "user" } }),
    ];
    expect(resolveAccess(id(), list).connection!.host).toBe("user");
    expect(resolveAccess(id({ email: "carl@x.com" }), list).connection!.host).toBe("domain");
    expect(resolveAccess(id({ email: "carl@y.com" }), list).connection!.host).toBe("group");
  });

  it("the first group in list order wins; assignments without a connection don't override one with a connection", () => {
    const list = [A({ id: 1, group: "g1" }), A({ id: 2, group: "g2", connection: { host: "two" } }), A({ id: 3, group: "g1", connection: { host: "three" } })];
    expect(resolveAccess(id(), list)).toMatchObject({ connection: { host: "two" }, assignment: "2" });
  });

  it("admin is true when any matching assignment is admin", () => {
    const list = [A({ id: 1, group: "g1", connection: { host: "x" } }), A({ id: 2, group: "g2", admin: true })];
    expect(resolveAccess(id(), list)).toMatchObject({ admin: true, connection: { host: "x" } });
    expect(resolveAccess(id({ groups: ["g1"] }), list).admin).toBe(false);
  });

  it("a user without e-mail only matches groups", () => {
    expect(resolveAccess(id({ email: null }), [A({ id: 1, user: "*@x.com" })]).allowed).toBe(false);
    expect(resolveAccess(id({ email: null }), [A({ id: 1, group: "g1" })]).allowed).toBe(true);
  });

  it("a user assignment can name the object id (sub/oid), independent of the e-mail", () => {
    const r = resolveAccess({ sub: "OID-1", email: null, groups: [] } as any, [A({ id: 1, user: "oid-1", admin: true })]);
    expect(r).toMatchObject({ allowed: true, admin: true });
    expect(resolveAccess({ sub: "oid-2", email: null, groups: [] } as any, [A({ id: 1, user: "oid-1" })]).allowed).toBe(false);
  });

  it("*@domain does not match a different domain with the same suffix", () => {
    expect(resolveAccess(id({ email: "a@evilx.com" }), [A({ id: 1, user: "*@x.com" })]).allowed).toBe(false);
  });
});

describe("assignmentError", () => {
  it.each([
    [{ group: "g" }, null], [{ user: "u@x.com", admin: true, connection: { host: "h" } }, null],
    [{}, /exactly one/], [{ group: "g", user: "u" }, /exactly one/], [{ group: 5 }, /non-empty strings/],
    [{ group: "g", connection: "x" }, /connection/], [{ group: "g", admin: "yes" }, /admin/], [null, /object/], [[], /object/],
  ])("%j → %s", (body: any, expected: RegExp | null) => {
    const r = assignmentError(body);
    if (expected === null) expect(r).toBeNull(); else expect(r).toMatch(expected);
  });
  it("partial updates need neither group nor user but still reject both", () => {
    expect(assignmentError({ admin: true }, { partial: true })).toBeNull();
    expect(assignmentError({ group: "a", user: "b" }, { partial: true })).toMatch(/only one/);
  });
});

describe("browser login", () => {
  const cfg = () => getOAuthConfig()!;

  it("startLogin builds an authorization URL with PKCE, state and nonce", async () => {
    const url = new URL(await startLogin(cfg()));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("https://mcp.test/auth/callback");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("nonce")).toBeTruthy();
  });

  async function login(claimsOverride: Record<string, unknown> = {}) {
    const q = new URL(await startLogin(cfg())).searchParams;
    idp.tokenResponse = () => ({
      ok: true, status: 200,
      json: async () => ({ id_token: idp.sign({ aud: CLIENT_ID, nonce: q.get("nonce"), email: "alice@x.com", groups: ["g1"], ...claimsOverride }) }),
    });
    return { q, run: () => finishLogin(cfg(), { code: "code-1", state: q.get("state") }) };
  }

  it("finishLogin exchanges the code (with the PKCE verifier) and returns the identity", async () => {
    const { q, run } = await login();
    const { identity, returnTo } = await run();
    expect(identity).toMatchObject({ email: "alice@x.com", groups: ["g1"] });
    expect(returnTo).toBe("/admin");
    const body = idp.lastTokenRequest!;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    const challenge = crypto.createHash("sha256").update(body.get("code_verifier")!).digest("base64url");
    expect(challenge).toBe(q.get("code_challenge"));
    expect(body.get("client_secret")).toBeNull();
  });

  it("sends the client secret when configured", async () => {
    process.env.OAUTH_CLIENT_SECRET = "s3cret";
    await (await login()).run();
    expect(idp.lastTokenRequest!.get("client_secret")).toBe("s3cret");
  });

  it("state is single use", async () => {
    const { run } = await login();
    await run();
    await expect(run()).rejects.toThrow(/state/);
  });

  it("rejects unknown state, missing code, id_token with wrong nonce or audience, and token endpoint errors", async () => {
    await expect(finishLogin(cfg(), { code: "c", state: "forged" })).rejects.toThrow(/state/);
    const s1 = new URL(await startLogin(cfg())).searchParams.get("state");
    await expect(finishLogin(cfg(), { code: null, state: s1 })).rejects.toThrow(/code/);
    await expect((await login({ nonce: "other" })).run()).rejects.toThrow(/nonce/);
    await expect((await login({ aud: "someone-else" })).run()).rejects.toThrow(/audience/);
    idp.tokenResponse = null;
    const s2 = new URL(await startLogin(cfg())).searchParams.get("state");
    await expect(finishLogin(cfg(), { code: "c", state: s2 })).rejects.toThrow(/bad code/);
  });

  it("rejects an expired login state", async () => {
    const { run } = await login();
    vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(Date.now() + 11 * 60_000); await expect(run()).rejects.toThrow(/state/); } finally { vi.useRealTimers(); }
  });
});

describe("sessions and cookies", () => {
  const identity = { email: "a@x.com", groups: [], display: "a@x.com" } as any;
  const reqWith = (id: string) => ({ headers: { cookie: `other=1; oramcp_session=${id}` } });

  it("creates, resolves and destroys a session", () => {
    const id = createSession(getOAuthConfig()!, identity);
    expect(sessionFromRequest(reqWith(id))!.identity).toBe(identity);
    expect(destroySession(id)).toBe(true);
    expect(sessionFromRequest(reqWith(id))).toBeNull();
  });
  it("expires sessions after OAUTH_SESSION_TTL", () => {
    process.env.OAUTH_SESSION_TTL = "60";
    const id = createSession(getOAuthConfig()!, identity);
    vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(Date.now() + 61_000); expect(sessionFromRequest(reqWith(id))).toBeNull(); } finally { vi.useRealTimers(); }
  });
  it("ignores unknown ids and requests without cookies", () => {
    expect(sessionFromRequest(reqWith("nope"))).toBeNull();
    expect(sessionFromRequest({ headers: {} })).toBeNull();
  });
  it("parseCookies / sessionCookie", () => {
    expect(parseCookies("a=1; b=x%20y")).toEqual({ a: "1", b: "x y" });
    const c = sessionCookie(getOAuthConfig()!, "abc", 100);
    expect(c).toBe("oramcp_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure");
    process.env.OAUTH_PUBLIC_URL = "http://localhost:3000";
    expect(sessionCookie(getOAuthConfig()!, "abc", 0)).not.toMatch(/Secure/);
  });
});
