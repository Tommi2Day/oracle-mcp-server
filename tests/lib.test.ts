import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeReq, makeRes } from "./helpers.js";

const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile:  vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: mockReadFile, writeFileSync: mockWriteFile, existsSync: vi.fn(() => false) },
}));

import {
  getLogLevel, isLogEnabled, log, getClientIp, extractBearer, hashToken, checkAuth, checkAdminAuth,
  loadTokenStore, saveTokenStore, migrateTokenStore, clearTokenStoreCache, validateConnection,
  cleanConnection, toSafeToken, type TokenRecord,
} from "../src/lib.js";

const ENOENT = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return { id: 1, name: "t1", token_hash: hashToken("secret-token"), created_at: "x", last_used_at: null,
    active: true, connection: null, ...overrides };
}

beforeEach(() => {
  clearTokenStoreCache();
  mockReadFile.mockImplementation(ENOENT);
  mockWriteFile.mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AUTH_TOKEN;
  delete process.env.LOG_LEVEL;
  delete process.env.STORE_ENCRYPTION_KEY;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("logging", () => {
  it("defaults to info and ignores invalid levels", () => {
    expect(getLogLevel()).toBe("info");
    process.env.LOG_LEVEL = "nonsense";
    expect(getLogLevel()).toBe("info");
    process.env.LOG_LEVEL = "DEBUG";
    expect(getLogLevel()).toBe("debug");
  });
  it("filters by level", () => {
    process.env.LOG_LEVEL = "warn";
    expect(isLogEnabled("info")).toBe(false);
    expect(isLogEnabled("error")).toBe(true);
  });
  it("writes the documented line format", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log("info", "MCP", "hello");
    expect(spy.mock.calls[0][0]).toMatch(/^\[\d{4}-\d\d-\d\dT.*Z\] \[INFO\] \[MCP\] hello$/);
  });
});

describe("getClientIp / extractBearer", () => {
  it("prefers x-real-ip, then x-forwarded-for", () => {
    expect(getClientIp(makeReq("GET", "/", { headers: { "x-real-ip": "1.1.1.1" } }))).toBe("1.1.1.1");
    expect(getClientIp(makeReq("GET", "/", { headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" } }))).toBe("2.2.2.2");
    expect(getClientIp(makeReq("GET", "/"))).toBe("-");
  });
  it("extracts bearer tokens", () => {
    expect(extractBearer(makeReq("GET", "/", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(extractBearer(makeReq("GET", "/", { headers: { authorization: "Basic abc" } }))).toBe("");
  });
});

describe("checkAuth", () => {
  it("allows anonymous access when AUTH_TOKEN is unset", async () => {
    expect(await checkAuth(makeReq("POST", "/mcp"), makeRes())).toEqual({ ok: true, name: "anonymous", connection: null });
  });
  it("accepts the admin token", async () => {
    process.env.AUTH_TOKEN = "admin-tok";
    expect(await checkAuth(makeReq("POST", "/mcp"), makeRes())).toMatchObject({ ok: true, name: "admin" });
  });
  it("rejects missing and unknown tokens with 401", async () => {
    process.env.AUTH_TOKEN = "admin-tok";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "" } }), res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect((await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "Bearer nope" } }), makeRes())).ok).toBe(false);
  });
  it("accepts an active file token and returns its connection", async () => {
    process.env.AUTH_TOKEN = "admin-tok";
    const conn = { tns_alias: "PROD", user: "app", password: "pw" };
    mockReadFile.mockReturnValue(JSON.stringify({ tokens: [token({ connection: conn })], next_id: 2 }));
    const r = await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "Bearer secret-token" } }), makeRes());
    expect(r).toEqual({ ok: true, name: "t1", connection: conn });
    expect(mockWriteFile).toHaveBeenCalled(); // last_used_at updated
  });
  it("rejects disabled file tokens", async () => {
    process.env.AUTH_TOKEN = "admin-tok";
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockReadFile.mockReturnValue(JSON.stringify({ tokens: [token({ active: false })], next_id: 2 }));
    const r = await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: "Bearer secret-token" } }), makeRes());
    expect(r.ok).toBe(false);
  });
  it("checkAdminAuth does not accept file tokens", () => {
    process.env.AUTH_TOKEN = "admin-tok";
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(checkAdminAuth(makeReq("GET", "/info", { headers: { authorization: "Bearer secret-token" } }), makeRes())).toBe(false);
    expect(checkAdminAuth(makeReq("GET", "/info", { headers: { authorization: "Bearer admin-tok" } }), makeRes())).toBe(true);
  });
});

describe("token store encryption", () => {
  it("returns an empty store when the file is missing", () => {
    expect(loadTokenStore()).toEqual({ tokens: [], next_id: 1 });
  });

  it("encrypts password and wallet_password when STORE_ENCRYPTION_KEY is set and decrypts on load", () => {
    process.env.STORE_ENCRYPTION_KEY = "k";
    saveTokenStore({ tokens: [token({ connection: { host: "h", password: "pw", wallet_password: "wpw" } })], next_id: 2 });
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).not.toContain("\"pw\"");
    expect(written).not.toContain("wpw");
    expect(written.match(/enc:v1:/g)).toHaveLength(2);

    clearTokenStoreCache();
    mockReadFile.mockReturnValueOnce(written);
    expect(loadTokenStore().tokens[0].connection).toEqual({ host: "h", password: "pw", wallet_password: "wpw" });
  });

  it("migrates plaintext secrets on startup", () => {
    process.env.STORE_ENCRYPTION_KEY = "k";
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockReadFile.mockReturnValueOnce(JSON.stringify({ tokens: [token({ connection: { host: "h", password: "pw" } })], next_id: 2 }));
    migrateTokenStore();
    expect(mockWriteFile.mock.calls[0][1]).toContain("enc:v1:");
  });

  it("migrate is a no-op without key", () => {
    migrateTokenStore();
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

describe("validateConnection / cleanConnection / toSafeToken", () => {
  it("accepts valid connections", () => {
    expect(validateConnection(null)).toBeNull();
    expect(validateConnection({ host: "h", port: 1521, protocol: "tcps", service_name: "s" })).toBeNull();
    expect(validateConnection({ connect_string: "jdbc:oracle:thin:@h:1521/s", ssl_server_dn_match: true })).toBeNull();
    expect(validateConnection({ diagnostics_pack: true, tuning_pack: "false" })).toBeNull();
    expect(validateConnection({ diagnostics_pack: "maybe" })).toMatch(/"diagnostics_pack" must be a boolean/);
    expect(validateConnection({ tns_alias: "X", tns_admin: "/opt/oracle/network/admin/prod" })).toBeNull();
  });
  it("rejects invalid connections", () => {
    expect(validateConnection([])).toMatch(/object/);
    expect(validateConnection({ database: "x" })).toMatch(/Unknown connection field/);
    expect(validateConnection({ host: 5 })).toMatch(/"host" must be a string/);
    expect(validateConnection({ port: "x" })).toMatch(/port/);
    expect(validateConnection({ protocol: "ipc" })).toMatch(/protocol/);
    expect(validateConnection({ tns_admin: "relative/dir" })).toMatch(/absolute/);
  });
  it("drops empty fields and returns null for empty objects", () => {
    expect(cleanConnection({ host: "h", sid: "", password: undefined })).toEqual({ host: "h" });
    expect(cleanConnection({ host: "" })).toBeNull();
  });
  it("hides hash and secrets in the safe view", () => {
    const safe = toSafeToken(token({ connection: { host: "h", password: "pw", wallet_password: "w" } }));
    expect(safe).not.toHaveProperty("token_hash");
    expect(safe.connection).toEqual({ host: "h", password_set: true, wallet_password_set: true });
  });
});
