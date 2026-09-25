/**
 * Pure helpers and auth logic — no MCP SDK or driver imports, pools are always injected.
 * Imported by index.ts (production) and tests.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extractJdbcCredentials, type OraConnection } from "./oracle.js";

// ── Logging ───────────────────────────────────────────────────────────────────
export type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Active log level from LOG_LEVEL env var (debug|info|warn|error), default info. */
export function getLogLevel(): LogLevel {
  const lvl = (process.env.LOG_LEVEL || "info").toLowerCase();
  return lvl in LOG_LEVELS ? lvl as LogLevel : "info";
}

export function isLogEnabled(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getLogLevel()];
}

/** Writes `[ISO timestamp] [LEVEL] [CATEGORY] message` to stderr if level is enabled. */
export function log(level: LogLevel, category: string, message: string): void {
  if (!isLogEnabled(level)) return;
  console.error(`[${new Date().toISOString()}] [${level.toUpperCase()}] [${category}] ${message}`);
}

/** Client IP: x-real-ip → first x-forwarded-for entry → socket address. */
export function getClientIp(req: IncomingMessage): string {
  const realIp = req.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp) return realIp;
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "-";
}

function logAuthFailure(req: IncomingMessage, reason: string, tokenName?: string): void {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  const tokenPart = tokenName ? ` token="${tokenName}"` : "";
  log("warn", "AUTH", `result="denied"${tokenPart} action="${req.method} ${pathname}" ip="${getClientIp(req)}" reason="${reason}"`);
}

// ── File / env helpers ────────────────────────────────────────────────────────
export function readFileEnv(envVar: string): Buffer | undefined {
  const path = process.env[envVar];
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch (e) {
    console.error(`❌ Cannot read ${envVar}="${path}": ${(e as Error).message}`);
    process.exit(1);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────
export function getAuthToken(): string {
  return process.env.AUTH_TOKEN || "";
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── Token store (file-based) ──────────────────────────────────────────────────
export interface TokenRecord {
  id: number;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  active: boolean;
  connection: OraConnection | null;
}

export interface TokenStore {
  tokens: TokenRecord[];
  next_id: number;
}

/** Connection fields that are encrypted at rest when STORE_ENCRYPTION_KEY is set. */
export const SECRET_FIELDS = ["password", "wallet_password"] as const;

export function getTokensFile(): string {
  return process.env.TOKENS_FILE || "./tokens.json";
}

let tokenStoreCache: TokenStore | null = null;
export function clearTokenStoreCache(): void { tokenStoreCache = null; }

// ── Store encryption (AES-256-GCM, keyed by STORE_ENCRYPTION_KEY env var) ─────
const ENC_PREFIX = "enc:v1:";

function getEncryptionKey(): Buffer | null {
  const raw = process.env.STORE_ENCRYPTION_KEY;
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest(); // 32-byte AES-256 key
}

function encryptValue(plaintext: string): string {
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString("hex") + ":" + tag.toString("hex") + ":" + ct.toString("hex");
}

function decryptValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return value;
  const key = getEncryptionKey();
  if (!key) {
    log("warn", "STORE", "Encrypted secret found but STORE_ENCRYPTION_KEY is not set — connection will fail.");
    return value;
  }
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted value in token store — check STORE_ENCRYPTION_KEY");
  try {
    const [ivHex, tagHex, ctHex] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex"), undefined, "utf8") + decipher.final("utf8");
  } catch (err) {
    throw new Error(`Failed to decrypt store value: ${(err as Error).message} — check STORE_ENCRYPTION_KEY`, { cause: err });
  }
}

function mapSecrets(conn: OraConnection | null, fn: (v: string) => unknown): OraConnection | null {
  if (!conn) return conn;
  const out: OraConnection = { ...conn };
  for (const f of SECRET_FIELDS) {
    if (typeof out[f] === "string" && out[f]) out[f] = fn(out[f] as string) as string;
  }
  return out;
}

export function loadTokenStore(): TokenStore {
  if (tokenStoreCache) return tokenStoreCache;
  const file = getTokensFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as TokenStore;
    for (const token of data.tokens) token.connection = mapSecrets(token.connection, decryptValue);
    tokenStoreCache = data;
    return data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { tokens: [], next_id: 1 };
    throw e;
  }
}

export function saveTokenStore(data: TokenStore): void {
  const file = getTokensFile();
  const toWrite = getEncryptionKey()
    ? { ...data, tokens: data.tokens.map(t => ({ ...t, connection: mapSecrets(t.connection, encryptValue) })) }
    : data;
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2), { encoding: "utf8", mode: 0o600 });
  tokenStoreCache = data;
}

/** On startup: find any tokens whose stored secrets are still plaintext and encrypt them. */
export function migrateTokenStore(): void {
  if (!getEncryptionKey()) return;
  const file = getTokensFile();
  let rawData: TokenStore;
  try {
    rawData = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let plainCount = 0;
  for (const t of rawData.tokens) {
    for (const f of SECRET_FIELDS) {
      const v = t.connection?.[f];
      if (typeof v === "string" && v && !v.startsWith(ENC_PREFIX)) plainCount++;
    }
  }
  if (plainCount === 0) return;
  for (const token of rawData.tokens) token.connection = mapSecrets(token.connection, decryptValue);
  saveTokenStore(rawData); // re-encrypts every secret
  log("info", "STORE", `Encrypted ${plainCount} plaintext secret(s) in token store.`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
export function extractBearer(req: IncomingMessage): string {
  const h = (req.headers && req.headers["authorization"]) || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function send401(res: ServerResponse): void {
  const realm = process.env.MCP_SERVER_NAME || "oracle-mcp-server";
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer realm="${realm}"`,
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > 1_048_576) { reject(new Error("Request body too large")); return; }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Admin-only auth — only the AUTH_TOKEN env var is accepted.
 *  When AUTH_TOKEN is not set, auth is disabled and all requests are allowed. */
export function checkAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const authToken = getAuthToken();
  if (!authToken) return true;
  const token = extractBearer(req);
  if (!token) { logAuthFailure(req, "missing token"); send401(res); return false; }
  if (!timingSafeEqual(token, authToken)) { logAuthFailure(req, "invalid admin token"); send401(res); return false; }
  return true;
}

export type AuthResult =
  | { ok: true; name: string; connection: OraConnection | null }
  | { ok: false };

/** MCP auth — accepts AUTH_TOKEN env var OR any active file token. */
export async function checkAuth(req: IncomingMessage, res: ServerResponse): Promise<AuthResult> {
  const authToken = getAuthToken();
  if (!authToken) return { ok: true, name: "anonymous", connection: null };
  const token = extractBearer(req);
  if (!token) { logAuthFailure(req, "missing token"); send401(res); return { ok: false }; }
  if (timingSafeEqual(token, authToken)) return { ok: true, name: "admin", connection: null };
  const hash = hashToken(token);
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.token_hash === hash);
  if (!entry) { logAuthFailure(req, "unknown token"); send401(res); return { ok: false }; }
  if (!entry.active) { logAuthFailure(req, "token disabled", entry.name); send401(res); return { ok: false }; }
  entry.last_used_at = new Date().toISOString();
  try { saveTokenStore(store); } catch { /* best-effort */ }
  return { ok: true, name: entry.name, connection: entry.connection || null };
}

// ── Connection validation ─────────────────────────────────────────────────────
const STRING_FIELDS = [
  "connect_string", "tns_alias", "host", "service_name", "sid", "protocol", "user", "password",
  "tns_admin", "wallet_location", "wallet_password", "ssl_server_cert_dn",
] as const;

const BOOLEAN_FIELDS = ["ssl_server_dn_match", "diagnostics_pack", "tuning_pack"] as const;

/** Returns an error message for an invalid per-token connection object, or null. */
export function validateConnection(c: unknown): string | null {
  if (c === null || c === undefined) return null;
  if (typeof c !== "object" || Array.isArray(c)) return '"connection" must be an object or null';
  const conn = c as Record<string, unknown>;
  for (const k of Object.keys(conn)) {
    if (![...STRING_FIELDS, ...BOOLEAN_FIELDS, "port"].includes(k)) return `Unknown connection field "${k}"`;
  }
  for (const k of STRING_FIELDS) {
    if (conn[k] !== undefined && conn[k] !== null && typeof conn[k] !== "string") return `"${k}" must be a string`;
  }
  for (const k of BOOLEAN_FIELDS) {
    const v = conn[k];
    if (v !== undefined && v !== null && v !== "" && typeof v !== "boolean" && !["true", "false"].includes(String(v).toLowerCase())) {
      return `"${k}" must be a boolean`;
    }
  }
  if (conn.port !== undefined && conn.port !== null && conn.port !== ""
      && !/^\d+$/.test(String(conn.port))) return '"port" must be a number';
  if (conn.protocol && !["tcp", "tcps"].includes(String(conn.protocol).toLowerCase())) return '"protocol" must be tcp or tcps';
  for (const k of ["tns_admin", "wallet_location"] as const) {
    if (conn[k] && !String(conn[k]).startsWith("/") && !/^[A-Za-z]:[\\/]/.test(String(conn[k]))) return `"${k}" must be an absolute path`;
  }
  return null;
}

/** Drops empty strings/nulls so stored connections only contain set fields. */
export function cleanConnection(c: OraConnection | null | undefined): OraConnection | null {
  if (!c) return null;
  const out = Object.fromEntries(
    Object.entries(extractJdbcCredentials(c)).filter(([, v]) => v !== undefined && v !== null && v !== "")
  ) as OraConnection;
  return Object.keys(out).length ? out : null;
}

// ── Admin: token management (/admin/tokens[/:id]) ────────────────────────────
type SafeToken = Omit<TokenRecord, "token_hash">;

/** Token without hash; secrets are replaced by a flag so they never leave the server. */
export function toSafeToken(t: TokenRecord): SafeToken {
  const { token_hash: _h, ...rest } = t;
  if (!rest.connection) return rest;
  const conn: Record<string, unknown> = { ...rest.connection };
  for (const f of SECRET_FIELDS) {
    if (conn[f]) { delete conn[f]; conn[`${f}_set`] = true; }
  }
  return { ...rest, connection: conn as OraConnection };
}

/** PATCH semantics for secrets: an omitted password keeps the stored one. */
function mergeSecrets(updated: OraConnection | null, existing: OraConnection | null): OraConnection | null {
  if (!updated || !existing) return updated;
  const out = { ...updated };
  for (const f of SECRET_FIELDS) {
    if (out[f] === undefined && existing[f]) out[f] = existing[f];
  }
  return out;
}

export interface AdminHooks {
  onDelete?: (token: TokenRecord) => void;
  onUpdate?: (before: TokenRecord, after: TokenRecord) => void;
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, { onDelete, onUpdate }: AdminHooks = {}): Promise<void> {
  if (!checkAdminAuth(req, res)) return;

  const pathname = new URL(req.url || "/", "http://x").pathname;
  const match = pathname.match(/^\/admin\/tokens(?:\/(\d+))?$/);
  if (!match) { sendJson(res, 404, { error: "Not found" }); return; }
  const id = match[1] ? parseInt(match[1], 10) : null;

  const ip = getClientIp(req);
  // Auth disabled → requests are unauthenticated, don't attribute them to the admin token
  const tokenName = getAuthToken() ? "admin" : "anonymous";
  log("info", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}"`);

  try {
    // GET /admin/tokens – list all tokens (token_hash and secrets excluded)
    if (req.method === "GET" && !id) {
      const { tokens } = loadTokenStore();
      sendJson(res, 200, { tokens: tokens.map(toSafeToken) });
      return;
    }

    // POST /admin/tokens – create new token
    if (req.method === "POST" && !id) {
      const { name, connection } = JSON.parse((await readBody(req)) || "{}");
      if (!name || typeof name !== "string" || !name.trim()) {
        sendJson(res, 400, { error: '"name" is required' });
        return;
      }
      const connErr = validateConnection(connection);
      if (connErr) { sendJson(res, 400, { error: connErr }); return; }
      const token = crypto.randomBytes(32).toString("hex");
      const store = loadTokenStore();
      const entry: TokenRecord = {
        id:           store.next_id++,
        name:         name.trim(),
        token_hash:   hashToken(token),
        created_at:   new Date().toISOString(),
        last_used_at: null,
        active:       true,
        connection:   cleanConnection(connection),
      };
      store.tokens.push(entry);
      saveTokenStore(store);
      sendJson(res, 201, { ...toSafeToken(entry), token }); // plaintext returned once only
      return;
    }

    // PATCH /admin/tokens/:id – update name, active and/or connection
    if (req.method === "PATCH" && id) {
      const updates = JSON.parse((await readBody(req)) || "{}");
      if (updates.name === undefined && updates.active === undefined && updates.connection === undefined) {
        sendJson(res, 400, { error: "No valid fields (name, active, connection)" });
        return;
      }
      if (updates.name !== undefined && (typeof updates.name !== "string" || !updates.name.trim())) {
        sendJson(res, 400, { error: '"name" must be a non-empty string' });
        return;
      }
      const connErr = validateConnection(updates.connection);
      if (connErr) { sendJson(res, 400, { error: connErr }); return; }
      const store = loadTokenStore();
      const entry = store.tokens.find(t => t.id === id);
      if (!entry) { sendJson(res, 404, { error: "Not found" }); return; }
      const before = { ...entry };
      if (updates.name !== undefined) entry.name = updates.name.trim();
      if (updates.active !== undefined) entry.active = !!updates.active;
      if (updates.connection !== undefined) {
        entry.connection = cleanConnection(mergeSecrets(updates.connection, entry.connection));
      }
      saveTokenStore(store);
      onUpdate?.(before, entry);
      sendJson(res, 200, toSafeToken(entry));
      return;
    }

    // DELETE /admin/tokens/:id – permanently remove token
    if (req.method === "DELETE" && id) {
      const store = loadTokenStore();
      const idx = store.tokens.findIndex(t => t.id === id);
      if (idx === -1) { sendJson(res, 404, { error: "Not found" }); return; }
      const [deleted] = store.tokens.splice(idx, 1);
      saveTokenStore(store);
      onDelete?.(deleted);
      sendJson(res, 200, { ok: true, id });
      return;
    }

    sendJson(res, 405, { error: "Method Not Allowed" });
  } catch (err) {
    const msg = (err as Error).message;
    log("error", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}" error=${JSON.stringify(msg)}`);
    if ((err as Error).stack) log("debug", "ADMIN", (err as Error).stack as string);
    sendJson(res, 500, { error: msg });
  }
}
