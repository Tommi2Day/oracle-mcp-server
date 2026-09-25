import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeReq, makeRes, resBody } from "./helpers.js";

const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile:  vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: mockReadFile, writeFileSync: mockWriteFile, existsSync: vi.fn(() => false) },
}));

import { handleAdminRequest, clearTokenStoreCache, type TokenRecord } from "../src/lib.js";

const ADMIN_TOKEN = "test-admin-token";

const makeToken = (o: Partial<TokenRecord> = {}): TokenRecord => ({
  id: 1, name: "t", token_hash: "h", active: true, created_at: "x", last_used_at: null, connection: null, ...o,
});
const seedStore = (tokens: TokenRecord[], next_id = tokens.length + 1) =>
  mockReadFile.mockReturnValueOnce(JSON.stringify({ tokens, next_id }));
const writtenStore = () => JSON.parse(mockWriteFile.mock.calls[0][1]);

describe("handleAdminRequest", () => {
  beforeEach(() => {
    clearTokenStoreCache();
    process.env.AUTH_TOKEN = ADMIN_TOKEN;
    mockReadFile.mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
    mockWriteFile.mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.AUTH_TOKEN;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns 401 for a wrong admin token", async () => {
    const res = makeRes();
    await handleAdminRequest(makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer wrong" } }), res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("lists tokens without hashes or secrets", async () => {
    seedStore([makeToken({ connection: { tns_alias: "P", user: "u", password: "pw" } })]);
    const res = makeRes();
    await handleAdminRequest(makeReq("GET", "/admin/tokens"), res);
    const body = resBody(res);
    expect(body.tokens[0]).not.toHaveProperty("token_hash");
    expect(body.tokens[0].connection).toEqual({ tns_alias: "P", user: "u", password_set: true });
  });

  it("creates a token with an Oracle connection and returns the plaintext token once", async () => {
    const res = makeRes();
    await handleAdminRequest(makeReq("POST", "/admin/tokens", {
      body: JSON.stringify({ name: " app ", connection: { host: "db", port: 2484, protocol: "tcps", service_name: "S", user: "u", password: "p" } }),
    }), res);
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    const body = resBody(res);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.name).toBe("app");
    expect(body.connection).not.toHaveProperty("password");
    expect(writtenStore().tokens[0].connection.password).toBe("p");
  });

  it("moves JDBC URL credentials into user/password on create", async () => {
    const res = makeRes();
    await handleAdminRequest(makeReq("POST", "/admin/tokens", {
      body: JSON.stringify({ name: "j", connection: { connect_string: "jdbc:oracle:thin:scott/tiger@h:1521/s" } }),
    }), res);
    expect(writtenStore().tokens[0].connection).toEqual({
      connect_string: "jdbc:oracle:thin:@h:1521/s", user: "scott", password: "tiger",
    });
    expect(JSON.stringify(resBody(res))).not.toContain("tiger");
  });

  it("rejects missing name and invalid connection", async () => {
    let res = makeRes();
    await handleAdminRequest(makeReq("POST", "/admin/tokens", { body: "{}" }), res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    res = makeRes();
    await handleAdminRequest(makeReq("POST", "/admin/tokens", { body: JSON.stringify({ name: "x", connection: { database: "pg" } }) }), res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(resBody(res).error).toMatch(/Unknown connection field/);
  });

  it("PATCH keeps the stored password when none is sent and calls onUpdate", async () => {
    seedStore([makeToken({ connection: { host: "old", user: "u", password: "pw" } })]);
    const onUpdate = vi.fn();
    const res = makeRes();
    await handleAdminRequest(makeReq("PATCH", "/admin/tokens/1", {
      body: JSON.stringify({ connection: { host: "new", user: "u" } }),
    }), res, { onUpdate });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(writtenStore().tokens[0].connection).toEqual({ host: "new", user: "u", password: "pw" });
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ connection: { host: "old", user: "u", password: "pw" } }),
      expect.objectContaining({ connection: { host: "new", user: "u", password: "pw" } }));
  });

  it("PATCH with connection null resets to default", async () => {
    seedStore([makeToken({ connection: { host: "old" } })]);
    const res = makeRes();
    await handleAdminRequest(makeReq("PATCH", "/admin/tokens/1", { body: JSON.stringify({ connection: null, active: false }) }), res);
    expect(writtenStore().tokens[0]).toMatchObject({ connection: null, active: false });
  });

  it("PATCH returns 404 for unknown ids and 400 without fields", async () => {
    seedStore([makeToken()]);
    let res = makeRes();
    await handleAdminRequest(makeReq("PATCH", "/admin/tokens/9", { body: JSON.stringify({ name: "x" }) }), res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    res = makeRes();
    await handleAdminRequest(makeReq("PATCH", "/admin/tokens/1", { body: "{}" }), res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it("DELETE removes the token and calls onDelete", async () => {
    seedStore([makeToken({ id: 1 }), makeToken({ id: 2, name: "b" })]);
    const onDelete = vi.fn();
    const res = makeRes();
    await handleAdminRequest(makeReq("DELETE", "/admin/tokens/1"), res, { onDelete });
    expect(resBody(res)).toEqual({ ok: true, id: 1 });
    expect(writtenStore().tokens.map((t: TokenRecord) => t.id)).toEqual([2]);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("returns 405 for unsupported methods and 404 for unknown paths", async () => {
    let res = makeRes();
    await handleAdminRequest(makeReq("PUT", "/admin/tokens"), res);
    expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    res = makeRes();
    await handleAdminRequest(makeReq("GET", "/admin/tokens/abc"), res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it("returns 500 on invalid JSON", async () => {
    const res = makeRes();
    await handleAdminRequest(makeReq("POST", "/admin/tokens", { body: "{nope" }), res);
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
  });
});
