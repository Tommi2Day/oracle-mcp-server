/**
 * Pure helpers and auth logic — no MCP SDK or driver imports, pools are always injected.
 * Imported by index.ts (production) and tests.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  extractJdbcCredentials, parseClientConnectionMode, ClientConnectionError,
  CLIENT_CREDENTIAL_FIELDS, CLIENT_TARGET_FIELDS,
  type OraConnection, type ClientConnectionMode,
} from "./oracle.js";
import {
  getOAuthConfig, verifyJwt, looksLikeJwt, identityFromClaims, resolveAccess, envAssignments,
  sessionFromRequest, safeLogValue, OAuthError, assignmentError, ASSIGNMENT_FIELDS,
  type Assignment, type Identity, type OAuthConfig,
} from "./oauth.js";

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

/** Audit trail line `[AUDIT] key="value" …` (who did what); values are sanitized, never contains secrets. */
export function audit(fields: Record<string, unknown>): void {
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${safeLogValue(v, 256)}"`);
  log("info", "AUDIT", parts.join(" "));
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
  /** What MCP clients of this token may set via X-Oracle-* headers (default: none). */
  client_connection?: ClientConnectionMode;
}

/** OAuth assignment created in the admin UI (stored next to the tokens). */
export interface StoredAssignment extends Assignment {
  id: number;
  created_at: string;
}

export interface TokenStore {
  tokens: TokenRecord[];
  next_id: number;
  assignments?: StoredAssignment[];
  next_assignment_id?: number;
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

function mapSecrets(conn: OraConnection | null | undefined, fn: (v: string) => unknown): OraConnection | null {
  if (!conn) return null;
  const out: OraConnection = { ...conn };
  for (const f of SECRET_FIELDS) {
    if (typeof out[f] === "string" && out[f]) out[f] = fn(out[f] as string) as string;
  }
  return out;
}

/** Applies fn to the stored connection secrets of every token and assignment. */
function mapStoreSecrets(data: TokenStore, fn: (v: string) => unknown): TokenStore {
  const map = <T extends { connection?: OraConnection | null }>(e: T): T => ({ ...e, connection: mapSecrets(e.connection, fn) });
  return {
    ...data,
    tokens: data.tokens.map(map),
    ...(Array.isArray(data.assignments) && { assignments: data.assignments.map(map) }),
  };
}

export function loadTokenStore(): TokenStore {
  if (tokenStoreCache) return tokenStoreCache;
  const file = getTokensFile();
  try {
    const data = mapStoreSecrets(JSON.parse(fs.readFileSync(file, "utf8")) as TokenStore, decryptValue);
    tokenStoreCache = data;
    return data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { tokens: [], next_id: 1 };
    throw e;
  }
}

export function saveTokenStore(data: TokenStore): void {
  const file = getTokensFile();
  const toWrite = getEncryptionKey() ? mapStoreSecrets(data, encryptValue) : data;
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2), { encoding: "utf8", mode: 0o600 });
  tokenStoreCache = data;
}

/** On startup: find any tokens / assignments whose stored secrets are still plaintext and encrypt them. */
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
  for (const t of [...rawData.tokens, ...(rawData.assignments ?? [])]) {
    for (const f of SECRET_FIELDS) {
      const v = t.connection?.[f];
      if (typeof v === "string" && v && !v.startsWith(ENC_PREFIX)) plainCount++;
    }
  }
  if (plainCount === 0) return;
  saveTokenStore(mapStoreSecrets(rawData, decryptValue)); // re-encrypts every secret
  log("info", "STORE", `Encrypted ${plainCount} plaintext secret(s) in token store.`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
export function extractBearer(req: IncomingMessage): string {
  const h = (req.headers && req.headers["authorization"]) || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function send401(res: ServerResponse): void {
  const realm = process.env.MCP_SERVER_NAME || "oracle-mcp-server";
  const publicUrl = getOAuthConfig()?.publicUrl;
  const metadata = publicUrl ? `, resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"` : "";
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer realm="${realm}"${metadata}`,
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function send403(res: ServerResponse, message = "Forbidden"): void {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** A malformed request body (answered with 400; the parser's message is never logged, it quotes the body). */
export class BadRequestError extends Error {}

/** Parsed JSON body ({} when empty). V8's JSON errors quote a snippet of the input, which may be a password. */
export async function readJsonBody(req: IncomingMessage): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch (e) {
    if (e instanceof SyntaxError) throw new BadRequestError("Invalid JSON body");
    throw e;
  }
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

export interface SessionIdentity {
  sub: string;
  email: string | null;
  name: string | null;
  assignment?: string;
  admin: boolean;
}

export type AuthResult =
  | { ok: true; name: string; connection: OraConnection | null; clientConnection: ClientConnectionMode; identity?: SessionIdentity }
  | { ok: false };

/** client_connection for the AUTH_TOKEN / anonymous sessions (ORA_CLIENT_CONNECTION, default none). */
export function envClientConnectionMode(): ClientConnectionMode {
  return parseClientConnectionMode(process.env.ORA_CLIENT_CONNECTION) ?? "none";
}

/** All assignments: env (read-only) first, then the ones stored via the admin UI. */
export function allAssignments(): Assignment[] {
  return [...envAssignments(), ...(loadTokenStore().assignments ?? [])];
}

/** Validates a bearer JWT. Returns { identity } or { error } (reason safe to log). */
async function verifyBearerIdentity(token: string, oauth: OAuthConfig): Promise<{ identity?: Identity; error?: string }> {
  try {
    return { identity: identityFromClaims(await verifyJwt(token, oauth), oauth) };
  } catch (e) {
    return { error: e instanceof OAuthError ? e.message : "token validation failed" };
  }
}

/** Authenticated identity → access decision; a denial is logged (AUTH). */
function decideAccess(req: IncomingMessage, identity: Identity) {
  const access = resolveAccess(identity, allAssignments());
  if (!access.allowed) {
    const hint = identity.groupsOverage ? " (token has too many groups: group list not included - use app-assigned groups or roles)" : "";
    logAuthFailure(req, `oauth: no assignment for this user or groups${hint}`, identity.display);
  }
  return access;
}

/** MCP request with an OAuth access token (JWT). */
async function checkOAuthBearer(req: IncomingMessage, res: ServerResponse, token: string, oauth: OAuthConfig): Promise<AuthResult> {
  const { identity, error } = await verifyBearerIdentity(token, oauth);
  if (!identity) { logAuthFailure(req, `oauth: ${error}`); send401(res); return { ok: false }; }
  const access = decideAccess(req, identity);
  if (!access.allowed) { send403(res, "No access: user or groups are not assigned to this server"); return { ok: false }; }
  return {
    ok: true, name: identity.display, connection: access.connection ?? null,
    clientConnection: parseClientConnectionMode(access.clientConnection) ?? "none",
    identity: { sub: identity.sub, email: identity.email, name: identity.name, assignment: access.assignment, admin: access.admin },
  };
}

/** File-token lookup for /mcp (see checkAuth). */
function checkFileToken(req: IncomingMessage, res: ServerResponse, token: string): AuthResult {
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.token_hash === hashToken(token));
  if (!entry) { logAuthFailure(req, "unknown token"); send401(res); return { ok: false }; }
  if (!entry.active) { logAuthFailure(req, "token disabled", entry.name); send401(res); return { ok: false }; }
  entry.last_used_at = new Date().toISOString();
  try { saveTokenStore(store); } catch { /* best-effort */ }
  return {
    ok: true, name: entry.name, connection: entry.connection || null,
    clientConnection: parseClientConnectionMode(entry.client_connection) ?? "none",
  };
}

/** MCP auth — accepts AUTH_TOKEN env var, any active file token or (OAUTH_ISSUER set) an OAuth access token.
 *  Without AUTH_TOKEN and OAuth, auth is disabled. */
export async function checkAuth(req: IncomingMessage, res: ServerResponse): Promise<AuthResult> {
  const authToken = getAuthToken();
  const oauth = getOAuthConfig();
  if (!authToken && !oauth) return { ok: true, name: "anonymous", connection: null, clientConnection: envClientConnectionMode() };
  const token = extractBearer(req);
  if (!token) { logAuthFailure(req, "missing token"); send401(res); return { ok: false }; }
  if (authToken && timingSafeEqual(token, authToken)) {
    return { ok: true, name: "admin", connection: null, clientConnection: envClientConnectionMode() };
  }
  if (oauth && looksLikeJwt(token)) return checkOAuthBearer(req, res, token, oauth);
  return checkFileToken(req, res, token);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type AdminAuth =
  | { ok: true; name: string; method: "token" | "none" | "oauth"; identity?: Identity }
  | { ok: false };

/** Identity behind an admin request: bearer JWT, else the browser session cookie. */
async function adminIdentity(req: IncomingMessage, token: string, oauth: OAuthConfig):
  Promise<{ identity?: Identity; via?: "bearer" | "session"; error?: string }> {
  if (token && looksLikeJwt(token)) return { ...await verifyBearerIdentity(token, oauth), via: "bearer" };
  const session = sessionFromRequest(req);
  return session ? { identity: session.identity, via: "session" } : { error: "missing token" };
}

/**
 * Admin API / Admin UI authentication (res is already answered when not ok).
 *  - AUTH_TOKEN bearer -> "admin"
 *  - OAuth (OAUTH_ISSUER): bearer JWT or login session of a user whose assignment has admin:true.
 *    Session cookies are protected against CSRF: changing requests need an X-Requested-With header.
 *  - neither configured -> "anonymous"
 */
export async function authenticateAdmin(req: IncomingMessage, res: ServerResponse): Promise<AdminAuth> {
  const oauth = getOAuthConfig();
  if (!oauth) {
    if (!checkAdminAuth(req, res)) return { ok: false };
    return getAuthToken() ? { ok: true, name: "admin", method: "token" } : { ok: true, name: "anonymous", method: "none" };
  }
  const token = extractBearer(req);
  const authToken = getAuthToken();
  if (token && authToken && timingSafeEqual(token, authToken)) return { ok: true, name: "admin", method: "token" };
  const { identity, via, error } = await adminIdentity(req, token, oauth);
  if (!identity) { logAuthFailure(req, `oauth: ${error}`); send401(res); return { ok: false }; }
  const access = decideAccess(req, identity);
  if (!access.admin) {
    if (access.allowed) logAuthFailure(req, "oauth: not an admin", identity.display);
    send403(res, "Admin rights required");
    return { ok: false };
  }
  if (via === "session" && !SAFE_METHODS.has(req.method || "GET") && !req.headers?.["x-requested-with"]) {
    logAuthFailure(req, "oauth: missing X-Requested-With header (CSRF protection)", identity.display);
    send403(res, "Missing X-Requested-With header");
    return { ok: false };
  }
  return { ok: true, name: identity.display, method: "oauth", identity };
}

// ── Client-supplied connection (X-Oracle-* headers) ──────────────────────────
export const CLIENT_HEADER_PREFIX = "x-oracle-";

/** Header name for a connection field: ssl_server_cert_dn → X-Oracle-Ssl-Server-Cert-Dn. */
export function clientHeaderName(field: string): string {
  return "X-Oracle-" + field.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join("-");
}

/**
 * Reads the connection parameters an MCP client sends as X-Oracle-* headers (e.g.
 * X-Oracle-User, X-Oracle-Host, X-Oracle-Connect-String). Returns null without such headers;
 * throws ClientConnectionError (400) on unknown headers or invalid values.
 */
export function clientConnectionFromHeaders(headers: IncomingMessage["headers"]): OraConnection | null {
  const known: readonly string[] = [...CLIENT_CREDENTIAL_FIELDS, ...CLIENT_TARGET_FIELDS];
  const conn: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith(CLIENT_HEADER_PREFIX) || value === undefined) continue;
    const field = name.slice(CLIENT_HEADER_PREFIX.length).replaceAll("-", "_");
    const v = (Array.isArray(value) ? value[0] : value).trim();
    if (!v) continue;
    if (!known.includes(field)) {
      throw new ClientConnectionError(`Unknown header ${clientHeaderName(field)} (allowed: ${known.map(clientHeaderName).join(", ")})`, 400);
    }
    conn[field] = v;
  }
  if (!Object.keys(conn).length) return null;
  const err = validateConnection(conn);
  if (err) throw new ClientConnectionError(err, 400);
  return conn as OraConnection;
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
  return unknownFieldError(conn) ?? fieldTypeError(conn) ?? fieldValueError(conn);
}

function unknownFieldError(conn: Record<string, unknown>): string | null {
  const known: readonly string[] = [...STRING_FIELDS, ...BOOLEAN_FIELDS, "port"];
  const unknown = Object.keys(conn).find(k => !known.includes(k));
  return unknown === undefined ? null : `Unknown connection field "${unknown}"`;
}

function isBooleanLike(v: unknown): boolean {
  return v === undefined || v === null || v === "" || typeof v === "boolean"
    || ["true", "false"].includes(String(v).toLowerCase());
}

function fieldTypeError(conn: Record<string, unknown>): string | null {
  const str = STRING_FIELDS.find(k => conn[k] !== undefined && conn[k] !== null && typeof conn[k] !== "string");
  if (str) return `"${str}" must be a string`;
  const bool = BOOLEAN_FIELDS.find(k => !isBooleanLike(conn[k]));
  return bool ? `"${bool}" must be a boolean` : null;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function fieldValueError(conn: Record<string, unknown>): string | null {
  if (conn.port !== undefined && conn.port !== null && conn.port !== ""
      && !/^\d+$/.test(String(conn.port))) return '"port" must be a number';
  if (conn.protocol && !["tcp", "tcps"].includes(String(conn.protocol).toLowerCase())) return '"protocol" must be tcp or tcps';
  const relative = (["tns_admin", "wallet_location"] as const).find(k => conn[k] && !isAbsolutePath(String(conn[k])));
  return relative ? `"${relative}" must be an absolute path` : null;
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

/** Called for tokens and assignments alike (both carry a connection → pool). */
export interface AdminHooks {
  onDelete?: (entry: { connection?: OraConnection | null }) => void;
  onUpdate?: (before: { connection?: OraConnection | null }, after: { connection?: OraConnection | null; active?: boolean }) => void;
}

const CLIENT_MODE_ERROR = '"client_connection" must be none, credentials or full';

/** ADMIN log line of every call; changing calls of OAuth users are also audited.
 *  Auth disabled → requests are unauthenticated; OAuth → the user's e-mail (or subject) is the actor. */
function logAdminCall(req: IncomingMessage, pathname: string, ip: string, admin: Extract<AdminAuth, { ok: true }>): void {
  const method = req.method || "GET";
  log("info", "ADMIN", `token="${admin.name}" action="${method} ${pathname}" ip="${ip}"`);
  if (admin.identity && !SAFE_METHODS.has(method)) {
    audit({ user: admin.identity.display, sub: admin.identity.sub, action: `${method} ${pathname}`, ip, via: "oauth-admin" });
  }
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, hooks: AdminHooks = {}): Promise<void> {
  const admin = await authenticateAdmin(req, res);
  if (!admin.ok) return;

  const pathname = new URL(req.url || "/", "http://x").pathname;
  const match = pathname.match(/^\/admin\/(tokens|assignments|me)(?:\/(\d+))?$/);
  if (!match) { sendJson(res, 404, { error: "Not found" }); return; }
  const id = match[2] ? Number.parseInt(match[2], 10) : null;

  const ip = getClientIp(req);
  const tokenName = admin.name;
  logAdminCall(req, pathname, ip, admin);

  try {
    const handler = adminHandler(match[1], req.method, id);
    if (!handler) { sendJson(res, 405, { error: "Method Not Allowed" }); return; }
    await handler(req, res, id as number, hooks, admin);
  } catch (err) {
    if (err instanceof BadRequestError) { sendJson(res, 400, { error: err.message }); return; }
    const msg = (err as Error).message;
    log("error", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}" error=${JSON.stringify(msg)}`);
    if ((err as Error).stack) log("debug", "ADMIN", (err as Error).stack as string);
    sendJson(res, 500, { error: msg });
  }
}

type AdminHandler = (req: IncomingMessage, res: ServerResponse, id: number, hooks: AdminHooks,
  admin: Extract<AdminAuth, { ok: true }>) => Promise<void> | void;

type RouteTable = Partial<Record<string, AdminHandler>>;

/** Per resource: GET/POST on the collection, PATCH/DELETE on /admin/<resource>/:id. */
function adminResources(): Record<string, { collection: RouteTable; item: RouteTable }> {
  return {
    tokens:      { collection: { GET: listTokens, POST: createToken }, item: { PATCH: updateToken, DELETE: deleteToken } },
    assignments: { collection: { GET: listAssignments, POST: createAssignment }, item: { PATCH: updateAssignment, DELETE: deleteAssignment } },
    me:          { collection: { GET: showMe }, item: {} },
  };
}

function adminHandler(resource: string, method: string | undefined, id: number | null): AdminHandler | null {
  const res = adminResources()[resource];
  const routes = id ? res.item : res.collection;
  return (method && Object.hasOwn(routes, method) ? routes[method] : undefined) ?? null;
}

// GET /admin/tokens – list all tokens (token_hash and secrets excluded)
function listTokens(_req: IncomingMessage, res: ServerResponse): void {
  const { tokens } = loadTokenStore();
  sendJson(res, 200, { tokens: tokens.map(toSafeToken) });
}

/** Validation of the POST body; returns an error message or null. */
function createError(body: { name?: unknown; connection?: unknown; client_connection?: unknown }): string | null {
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) return '"name" is required';
  return validateConnection(body.connection)
    ?? (parseClientConnectionMode(body.client_connection) ? null : CLIENT_MODE_ERROR);
}

// POST /admin/tokens – create new token
async function createToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const err = createError(body);
  if (err) { sendJson(res, 400, { error: err }); return; }
  const clientMode = parseClientConnectionMode(body.client_connection) as ClientConnectionMode;
  const token = crypto.randomBytes(32).toString("hex");
  const store = loadTokenStore();
  const entry: TokenRecord = {
    id:           store.next_id++,
    name:         body.name.trim(),
    token_hash:   hashToken(token),
    created_at:   new Date().toISOString(),
    last_used_at: null,
    active:       true,
    connection:   cleanConnection(body.connection),
    ...(clientMode !== "none" && { client_connection: clientMode }),
  };
  store.tokens.push(entry);
  saveTokenStore(store);
  sendJson(res, 201, { ...toSafeToken(entry), token }); // plaintext returned once only
}

/** Validation of the PATCH body; returns an error message or null. */
function updateError(updates: Record<string, unknown>): string | null {
  if (updates.name === undefined && updates.active === undefined && updates.connection === undefined
      && updates.client_connection === undefined) {
    return "No valid fields (name, active, connection, client_connection)";
  }
  if (updates.name !== undefined && (typeof updates.name !== "string" || !updates.name.trim())) {
    return '"name" must be a non-empty string';
  }
  return validateConnection(updates.connection)
    ?? (parseClientConnectionMode(updates.client_connection) ? null : CLIENT_MODE_ERROR);
}

/** Applies validated PATCH fields to a stored token. */
function applyTokenUpdates(entry: TokenRecord, updates: Record<string, unknown>): void {
  if (updates.name !== undefined) entry.name = (updates.name as string).trim();
  if (updates.active !== undefined) entry.active = !!updates.active;
  if (updates.connection !== undefined) {
    entry.connection = cleanConnection(mergeSecrets(updates.connection as OraConnection | null, entry.connection));
  }
  if (updates.client_connection === undefined) return;
  const clientMode = parseClientConnectionMode(updates.client_connection);
  if (clientMode === "none") delete entry.client_connection;
  else entry.client_connection = clientMode as ClientConnectionMode;
}

// PATCH /admin/tokens/:id – update name, active and/or connection
async function updateToken(req: IncomingMessage, res: ServerResponse, id: number, { onUpdate }: AdminHooks): Promise<void> {
  const updates = await readJsonBody(req);
  const err = updateError(updates);
  if (err) { sendJson(res, 400, { error: err }); return; }
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.id === id);
  if (!entry) { sendJson(res, 404, { error: "Not found" }); return; }
  const before = { ...entry };
  applyTokenUpdates(entry, updates);
  saveTokenStore(store);
  onUpdate?.(before, entry);
  sendJson(res, 200, toSafeToken(entry));
}

// DELETE /admin/tokens/:id – permanently remove token
function deleteToken(_req: IncomingMessage, res: ServerResponse, id: number, { onDelete }: AdminHooks): void {
  const store = loadTokenStore();
  const idx = store.tokens.findIndex(t => t.id === id);
  if (idx === -1) { sendJson(res, 404, { error: "Not found" }); return; }
  const [deleted] = store.tokens.splice(idx, 1);
  saveTokenStore(store);
  onDelete?.(deleted);
  sendJson(res, 200, { ok: true, id });
}

// ── Admin: OAuth assignments (/admin/assignments[/:id]) and /admin/me ────────
/** Secrets of a connection are replaced by `<field>_set` flags (like for tokens). */
function toSafeAssignment<T extends { connection?: OraConnection | null }>(e: T): T {
  if (!e.connection) return e;
  const conn: Record<string, unknown> = { ...e.connection };
  for (const f of SECRET_FIELDS) {
    if (conn[f]) { delete conn[f]; conn[`${f}_set`] = true; }
  }
  return { ...e, connection: conn as OraConnection };
}

// GET /admin/assignments – env assignments (read-only) followed by the stored ones; secrets never leave the server
function listAssignments(_req: IncomingMessage, res: ServerResponse): void {
  const stored = (loadTokenStore().assignments ?? []).map(a => ({ ...toSafeAssignment(a), source: "store" }));
  sendJson(res, 200, { assignments: [...envAssignments().map(toSafeAssignment), ...stored] });
}

/** Picks the known assignment fields out of a request body. */
const pickAssignment = (body: Record<string, unknown>): Partial<Assignment> =>
  Object.fromEntries(ASSIGNMENT_FIELDS.filter(k => body[k] !== undefined).map(k => [k, body[k]]));

/** Validation shared by POST and PATCH; returns an error message or null. */
function assignmentBodyError(body: Record<string, unknown>, partial: boolean): string | null {
  return assignmentError(body, { partial })
    ?? (parseClientConnectionMode(body.client_connection) ? null : CLIENT_MODE_ERROR)
    ?? validateConnection(body.connection);
}

// POST /admin/assignments – { group | user, connection, client_connection, admin, note }
async function createAssignment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const error = assignmentBodyError(body, false);
  if (error) { sendJson(res, 400, { error }); return; }
  const store = loadTokenStore();
  const entry: StoredAssignment = {
    ...pickAssignment(body),
    id: store.next_assignment_id ?? 1,
    connection: cleanConnection(body.connection),
    created_at: new Date().toISOString(),
  };
  if (entry.client_connection === "none") delete entry.client_connection;
  store.next_assignment_id = entry.id + 1;
  store.assignments = [...(store.assignments ?? []), entry];
  saveTokenStore(store);
  sendJson(res, 201, { ...toSafeAssignment(entry), source: "store" });
}

// PATCH /admin/assignments/:id – change connection, client_connection, admin, note (not group/user: delete and re-create)
async function updateAssignment(req: IncomingMessage, res: ServerResponse, id: number, { onUpdate }: AdminHooks): Promise<void> {
  const updates = await readJsonBody(req);
  if (updates.group !== undefined || updates.user !== undefined) {
    sendJson(res, 400, { error: '"group" and "user" cannot be changed' });
    return;
  }
  const error = assignmentBodyError(updates, true);
  if (error) { sendJson(res, 400, { error }); return; }
  const store = loadTokenStore();
  const entry = (store.assignments ?? []).find(a => a.id === id);
  if (!entry) { sendJson(res, 404, { error: "Not found" }); return; }
  const before = { ...entry };
  Object.assign(entry, pickAssignment(updates));
  if (updates.connection !== undefined) {
    entry.connection = cleanConnection(mergeSecrets(updates.connection as OraConnection | null, before.connection ?? null));
  }
  if (entry.client_connection === "none") delete entry.client_connection;
  saveTokenStore(store);
  onUpdate?.(before, entry);
  sendJson(res, 200, { ...toSafeAssignment(entry), source: "store" });
}

// DELETE /admin/assignments/:id
function deleteAssignment(_req: IncomingMessage, res: ServerResponse, id: number, { onDelete }: AdminHooks): void {
  const store = loadTokenStore();
  const list = store.assignments ?? [];
  const idx = list.findIndex(a => a.id === id);
  if (idx === -1) { sendJson(res, 404, { error: "Not found" }); return; }
  const [deleted] = list.splice(idx, 1);
  store.assignments = list;
  saveTokenStore(store);
  onDelete?.(deleted);
  sendJson(res, 200, { ok: true, id });
}

// GET /admin/me – who is calling and how the server is secured (for the admin UI)
function showMe(_req: IncomingMessage, res: ServerResponse, _id: number, _hooks: AdminHooks,
  admin: Extract<AdminAuth, { ok: true }>): void {
  const oauth = getOAuthConfig();
  sendJson(res, 200, {
    name: admin.name, method: admin.method,
    email: admin.identity?.email ?? null, user_name: admin.identity?.name ?? null,
    oauth: oauth && {
      issuer: oauth.issuer, groups_claim: oauth.groupsClaim, audience: oauth.audience,
      session_ttl: oauth.sessionTtl,
    },
  });
}
