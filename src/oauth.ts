/**
 * OAuth 2.0 / OpenID Connect support (Microsoft Entra ID first, any OIDC provider works).
 * Pure helpers — no MCP SDK and no lib.ts imports (lib.ts imports this module and does the logging).
 *
 *  - bearer access tokens (JWT) are validated against the issuer's JWKS (RS*, PS*, ES*)
 *  - identity (email, groups) comes from token claims
 *  - assignments (group / user → default connection, admin) decide who may use the server
 *  - browser login for the admin UI: authorization code flow with PKCE, server-side session cookie
 */
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OraConnection, ClientConnectionMode } from "./oracle.js";

export class OAuthError extends Error {}

const csv = (v: string | undefined): string[] => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
const words = (v: string | undefined): string[] => String(v || "").split(/[\s,]+/).filter(Boolean);
const stripSlash = (s: string): string => String(s).replace(/\/+$/, "");
const flag = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v || "");

// ── Configuration (environment, read on every call) ──────────────────────────
export interface OAuthConfig {
  issuer: string;
  issuers: string[];
  audience: string[];
  /** Scopes advertised in the protected-resource metadata (OAUTH_RESOURCE_SCOPES; default `<audience>/.default`). */
  resourceScopes: string[];
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  redirectUri: string;
  scopes: string;
  groupsClaim: string;
  emailClaim: string;
  requireVerifiedEmail: boolean;
  jwksUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  sessionTtl: number;
}

/** OAuth configuration from OAUTH_* env vars; null when OAUTH_ISSUER is not set (OAuth disabled). */
export function getOAuthConfig(): OAuthConfig | null {
  const env = process.env;
  const issuer = stripSlash((env.OAUTH_ISSUER || "").trim());
  if (!issuer) return null;
  const clientId = (env.OAUTH_CLIENT_ID || "").trim();
  const publicUrl = stripSlash((env.OAUTH_PUBLIC_URL || "").trim());
  const ttl = Number.parseInt(env.OAUTH_SESSION_TTL || "28800", 10);
  const allowedIssuers = csv(env.OAUTH_ALLOWED_ISSUERS);
  const audience = csv(env.OAUTH_AUDIENCE);
  const fallbackRedirect = publicUrl ? `${publicUrl}/auth/callback` : "";
  return {
    issuer,
    issuers: (allowedIssuers.length ? allowedIssuers : [issuer]).map(stripSlash),
    audience: audience.length ? audience : [clientId].filter(Boolean),
    resourceScopes: words(env.OAUTH_RESOURCE_SCOPES).length
      ? words(env.OAUTH_RESOURCE_SCOPES)
      : (audience.length ? audience : [clientId].filter(Boolean)).map(a => `${a}/.default`),
    clientId,
    clientSecret: env.OAUTH_CLIENT_SECRET || "",
    publicUrl,
    redirectUri: (env.OAUTH_REDIRECT_URI || "").trim() || fallbackRedirect,
    scopes: (env.OAUTH_SCOPES || "openid profile email").trim(),
    groupsClaim: (env.OAUTH_GROUPS_CLAIM || "groups").trim(),
    emailClaim: (env.OAUTH_EMAIL_CLAIM || "").trim(),
    requireVerifiedEmail: flag(env.OAUTH_REQUIRE_VERIFIED_EMAIL),
    jwksUri: (env.OAUTH_JWKS_URI || "").trim(),
    authorizationEndpoint: (env.OAUTH_AUTHORIZATION_ENDPOINT || "").trim(),
    tokenEndpoint: (env.OAUTH_TOKEN_ENDPOINT || "").trim(),
    sessionTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 28800,
  };
}

/** Human readable configuration errors (empty list = usable). */
export function oauthConfigProblems(config: OAuthConfig | null = getOAuthConfig()): string[] {
  if (!config) return [];
  const problems: string[] = [];
  if (!config.audience.length) problems.push("OAUTH_AUDIENCE or OAUTH_CLIENT_ID is required to validate access tokens");
  if (config.clientId && !config.redirectUri) problems.push("browser login needs OAUTH_PUBLIC_URL or OAUTH_REDIRECT_URI");
  return problems;
}

/** Browser login (admin UI) is only offered with a client id and a redirect URI. */
export const browserLoginEnabled = (config: OAuthConfig | null): config is OAuthConfig =>
  !!(config?.clientId && config.redirectUri);

// ── Provider metadata and signing keys ───────────────────────────────────────
const META_TTL_MS = 3600_000;
const JWKS_REFRESH_MS = 30_000;
const FETCH_TIMEOUT_MS = 5000;

interface ProviderMetadata { jwks_uri?: string; authorization_endpoint?: string; token_endpoint?: string }
let metaCache: { key: string; at: number; value: ProviderMetadata } | null = null;
let jwksCache: { uri: string; at: number; keys: Map<string, crypto.KeyObject> } | null = null;

export function clearOAuthCache(): void {
  metaCache = null; jwksCache = null;
  pendingLogins.clear(); sessions.clear();
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new OAuthError(`cannot reach ${new URL(url).host}: ${(e as Error).message}`, { cause: e });
  }
  const body = await res.json().catch(() => ({})) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok) throw new OAuthError(body.error_description || body.error || `HTTP ${res.status} from ${new URL(url).host}`);
  return body;
}

async function discover(config: OAuthConfig): Promise<ProviderMetadata> {
  if (metaCache?.key === config.issuer && Date.now() - metaCache.at < META_TTL_MS) return metaCache.value;
  const value = await fetchJson(`${config.issuer}/.well-known/openid-configuration`);
  metaCache = { key: config.issuer, at: Date.now(), value };
  return value;
}

/** OIDC discovery document (cached 1 h); explicit OAUTH_*_ENDPOINT settings win. */
export async function getMetadata(config: OAuthConfig): Promise<ProviderMetadata> {
  const explicit = config.jwksUri && config.authorizationEndpoint && config.tokenEndpoint;
  const base = explicit ? {} : await discover(config);
  return {
    jwks_uri: config.jwksUri || base.jwks_uri,
    authorization_endpoint: config.authorizationEndpoint || base.authorization_endpoint,
    token_endpoint: config.tokenEndpoint || base.token_endpoint,
  };
}

async function loadJwks(uri: string): Promise<Map<string, crypto.KeyObject>> {
  const { keys = [] } = await fetchJson(uri) as { keys?: (crypto.JsonWebKey & { use?: string; kid?: string })[] };
  const map = new Map<string, crypto.KeyObject>();
  for (const jwk of keys) {
    if (jwk.use && jwk.use !== "sig") continue;
    try { map.set(jwk.kid ?? "", crypto.createPublicKey({ key: jwk, format: "jwk" })); } catch { /* unsupported key */ }
  }
  jwksCache = { uri, at: Date.now(), keys: map };
  return map;
}

/** Key by `kid`; a token without kid matches a key set with exactly one key. */
function pickKey(keys: Map<string, crypto.KeyObject> | undefined, kid: string): crypto.KeyObject | undefined {
  const byKid = keys?.get(kid);
  if (byKid || kid || keys?.size !== 1) return byKid;
  return [...keys.values()][0];
}

/** Signing key by `kid`; the key set is refreshed (at most every 30 s) when the kid is unknown (key rotation). */
async function getSigningKey(config: OAuthConfig, kid = ""): Promise<crypto.KeyObject> {
  const { jwks_uri: uri } = await getMetadata(config);
  if (!uri) throw new OAuthError("issuer has no jwks_uri");
  const cached = jwksCache?.uri === uri ? jwksCache : null;
  let key = pickKey(cached?.keys, kid);
  if (!key && (!cached || Date.now() - cached.at > JWKS_REFRESH_MS)) key = pickKey(await loadJwks(uri), kid);
  if (!key) throw new OAuthError("signing key not found");
  return key;
}

// ── JWT validation ───────────────────────────────────────────────────────────
interface Algorithm { hash: string; pss?: boolean; ec?: boolean }
const ALGORITHMS: Record<string, Algorithm> = {
  RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true }, PS384: { hash: "sha384", pss: true }, PS512: { hash: "sha512", pss: true },
  ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true },
};
const CLOCK_SKEW_S = 60;

export type Claims = Record<string, unknown>;
interface DecodedJwt { header: { alg?: unknown; kid?: string }; payload: Claims; signature: Buffer; signingInput: string }

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** True for strings shaped like a compact JWT (three base64url parts). */
export const looksLikeJwt = (token: string | undefined): boolean => /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token || "");

export function decodeJwt(token: string): DecodedJwt {
  if (!looksLikeJwt(token)) throw new OAuthError("not a JWT");
  const [h, p, s] = token.split(".");
  try {
    return { header: b64json(h), payload: b64json(p), signature: Buffer.from(s, "base64url"), signingInput: `${h}.${p}` };
  } catch (e) {
    throw new OAuthError("malformed JWT", { cause: e });
  }
}

function verifySignature(jwt: DecodedJwt, key: crypto.KeyObject): void {
  const name = String(jwt.header.alg);
  const alg = Object.hasOwn(ALGORITHMS, name) ? ALGORITHMS[name] : undefined; // "none" and HS* are never accepted
  if (!alg) throw new OAuthError(`unsupported algorithm ${JSON.stringify(name)}`);
  const input = Buffer.from(jwt.signingInput);
  let options: crypto.KeyObject | crypto.VerifyKeyObjectInput = key;
  if (alg.pss) options = { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST };
  if (alg.ec) options = { key, dsaEncoding: "ieee-p1363" };
  let ok = false;
  try { ok = crypto.verify(alg.hash, input, options, jwt.signature); } catch { /* key type does not match alg */ }
  if (!ok) throw new OAuthError("invalid signature");
}

function checkTimes(p: Claims, now: number): void {
  if (typeof p.exp !== "number") throw new OAuthError("token has no exp claim");
  if (now > p.exp + CLOCK_SKEW_S) throw new OAuthError("token expired");
  if (typeof p.nbf === "number" && now < p.nbf - CLOCK_SKEW_S) throw new OAuthError("token not yet valid");
}

function checkClaims(p: Claims, config: OAuthConfig, { audience, nonce }: { audience: string[]; nonce?: string }): void {
  checkTimes(p, Math.floor(Date.now() / 1000));
  if (!config.issuers.includes(stripSlash(String(p.iss || "")))) throw new OAuthError("issuer not accepted");
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!audience.length || !aud.some(a => audience.includes(a as string))) throw new OAuthError("audience not accepted");
  if (nonce !== undefined && p.nonce !== nonce) throw new OAuthError("nonce mismatch");
}

/** Verifies signature, issuer, audience and lifetime; returns the claims. Throws OAuthError. */
export async function verifyJwt(token: string, config: OAuthConfig,
  { audience = config.audience, nonce }: { audience?: string[]; nonce?: string } = {}): Promise<Claims> {
  const jwt = decodeJwt(token);
  const key = await getSigningKey(config, jwt.header.kid);
  verifySignature(jwt, key);
  checkClaims(jwt.payload, config, { audience, nonce });
  return jwt.payload;
}

// ── Identity ─────────────────────────────────────────────────────────────────
const getClaim = (payload: Claims, path: string): unknown =>
  (path in payload ? payload[path] : path.split(".").reduce<unknown>((o, k) => (o as Claims | undefined)?.[k], payload));
const firstString = (values: unknown[]): string | undefined =>
  values.find((v): v is string => typeof v === "string" && !!v.trim());

/** Printable, quote-free value for log lines and session tags. */
export const safeLogValue = (s: unknown, max = 128): string =>
  String(s ?? "").replace(/[^\x20-\x7e]|["\\]/g, "?").slice(0, max);

export interface Identity {
  sub: string;
  email: string | null;
  name: string | null;
  display: string;
  groups: string[];
  groupsOverage: boolean;
}

/** E-mail of the claims; one the provider marks as unverified (or, with OAUTH_REQUIRE_VERIFIED_EMAIL, not verified) is never used for matching. */
function emailFromClaims(payload: Claims, config: OAuthConfig): string | undefined {
  const emailOk = payload.email_verified === true || (payload.email_verified !== false && !config.requireVerifiedEmail);
  if (!emailOk) return undefined;
  const custom = config.emailClaim ? getClaim(payload, config.emailClaim) : undefined;
  return firstString([custom, payload.email, payload.preferred_username, payload.upn])?.trim().toLowerCase();
}

/** { sub, email, name, display, groups[], groupsOverage } from validated claims. */
export function identityFromClaims(payload: Claims, config: OAuthConfig): Identity {
  const email = emailFromClaims(payload, config);
  const raw = getClaim(payload, config.groupsClaim);
  const groups = (Array.isArray(raw) ? raw : [raw]).filter((g): g is string => typeof g === "string" && !!g).map(g => g.toLowerCase());
  const sub = String(payload.oid || payload.sub || payload.azp || "");
  const names = payload._claim_names as Claims | undefined;
  return {
    sub, email: email || null, name: typeof payload.name === "string" ? payload.name : null,
    display: safeLogValue(email || sub || "unknown"),
    groups,
    // Entra: more than ~200 groups are not put into the token (only a pointer to Graph)
    groupsOverage: !!(names?.groups || payload.hasgroups),
  };
}

// ── Assignments (who may use the server, with which default connection) ──────
export interface Assignment {
  id?: number | string;
  group?: string;
  user?: string;
  connection?: OraConnection | null;
  client_connection?: ClientConnectionMode;
  admin?: boolean;
  note?: string;
  source?: "env" | "store";
}

export interface Access {
  allowed: boolean;
  admin: boolean;
  connection?: OraConnection | null;
  clientConnection?: ClientConnectionMode;
  assignment?: string;
}

/** What an assignment may contain: group xor user, connection (object|null), client_connection, admin. */
export const ASSIGNMENT_FIELDS = ["group", "user", "connection", "client_connection", "admin", "note"] as const;

function envJsonAssignments(): Assignment[] {
  const raw = process.env.OAUTH_ASSIGNMENTS;
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch (e) { throw new OAuthError(`OAUTH_ASSIGNMENTS is not valid JSON: ${(e as Error).message}`, { cause: e }); }
  if (!Array.isArray(list)) throw new OAuthError("OAUTH_ASSIGNMENTS must be a JSON array");
  return list as Assignment[];
}

/** Assignments from env: OAUTH_ASSIGNMENTS (JSON array), OAUTH_ALLOWED_GROUPS / OAUTH_ALLOWED_USERS and
 *  OAUTH_ADMIN_GROUPS / OAUTH_ADMIN_USERS (comma lists, default connection). Read-only in the admin UI. */
export function envAssignments(): Assignment[] {
  const simple: Assignment[] = [
    ...csv(process.env.OAUTH_ALLOWED_GROUPS).map(group => ({ group })),
    ...csv(process.env.OAUTH_ALLOWED_USERS).map(user => ({ user })),
    ...csv(process.env.OAUTH_ADMIN_GROUPS).map(group => ({ group, admin: true })),
    ...csv(process.env.OAUTH_ADMIN_USERS).map(user => ({ user, admin: true })),
  ];
  return [...envJsonAssignments(), ...simple].map((a, i) => ({
    ...a, id: `env-${i + 1}`, source: "env" as const, connection: a.connection ?? null,
  }));
}

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const isBlank = (v: unknown): boolean => typeof v !== "string" || !v.trim();

/** Validation error text for an assignment body (create), or null. */
export function assignmentError(a: unknown, { partial = false } = {}): string | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "assignment must be an object";
  const body = a as Record<string, unknown>;
  const hasGroup = isSet(body.group);
  const hasUser = isSet(body.user);
  if (!partial && hasGroup === hasUser) return 'exactly one of "group" or "user" is required';
  if (hasGroup && hasUser) return 'only one of "group" or "user" may be set';
  if ((hasGroup && isBlank(body.group)) || (hasUser && isBlank(body.user))) return '"group" and "user" must be non-empty strings';
  const c = body.connection;
  if (c !== undefined && c !== null && (typeof c !== "object" || Array.isArray(c))) return '"connection" must be an object or null';
  if (body.admin !== undefined && typeof body.admin !== "boolean") return '"admin" must be true or false';
  return null;
}

const lc = (s: string): string => String(s).trim().toLowerCase();

/** user "alice@x.com" matches exactly; "*@x.com" matches the whole domain. Returns specificity (2 exact, 1 domain, 0 none). */
function userMatch(pattern: string, identity: Identity): number {
  const p = lc(pattern);
  if (identity.sub && p === lc(identity.sub)) return 2; // immutable object id (Entra oid): safest way to name a user
  const email = identity.email;
  if (!email) return 0;
  if (p === email) return 2;
  return p.startsWith("*@") && email.endsWith(p.slice(1)) ? 1 : 0;
}

/** Lower is better: 0 exact user, 1 domain pattern, 2 group; -1 = no match. */
function matchPriority(a: Assignment, identity: Identity): number {
  if (a.user) return [-1, 1, 0][userMatch(a.user, identity)];
  return a.group && identity.groups.includes(lc(a.group)) ? 2 : -1;
}

/**
 * Access decision for an identity.
 *  allowed  – at least one assignment matches (OAuth is deny-by-default)
 *  admin    – a matching assignment has admin:true
 *  connection / clientConnection / assignment – from the best matching assignment that sets a
 *    connection: exact user, then domain pattern, then group (in list order: env first, then the store);
 *    without any, the server default connection (null).
 */
export function resolveAccess(identity: Identity, assignments: Assignment[]): Access {
  const scored = assignments
    .map((a, order) => ({ a, order, priority: matchPriority(a, identity) }))
    .filter(s => s.priority >= 0)
    .sort((x, y) => x.priority - y.priority || x.order - y.order);
  if (!scored.length) return { allowed: false, admin: false };
  const primary = scored.find(s => s.a.connection) ?? scored[0];
  return {
    allowed: true,
    admin: scored.some(s => s.a.admin === true),
    connection: primary.a.connection ?? null,
    clientConnection: primary.a.client_connection ?? "none",
    assignment: String(primary.a.id ?? ""),
  };
}

// ── Browser login (authorization code + PKCE) and sessions ───────────────────
const LOGIN_TTL_MS = 600_000;
const MAX_ENTRIES = 5000;
const pendingLogins = new Map<string, { verifier: string; nonce: string; at: number; returnTo: string }>();
const sessions = new Map<string, { identity: Identity; expires: number }>();

const randomToken = (n = 32): string => crypto.randomBytes(n).toString("base64url");

function prune<V>(map: Map<string, V>, isExpired: (v: V) => boolean): void {
  for (const [k, v] of map) if (isExpired(v)) map.delete(k);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

/** Authorization URL for the redirect to the identity provider. */
export async function startLogin(config: OAuthConfig, returnTo = "/admin"): Promise<string> {
  const { authorization_endpoint: endpoint } = await getMetadata(config);
  if (!endpoint) throw new OAuthError("issuer has no authorization_endpoint");
  prune(pendingLogins, v => Date.now() - v.at > LOGIN_TTL_MS);
  const state = randomToken(); const nonce = randomToken(); const verifier = randomToken(48);
  pendingLogins.set(state, { verifier, nonce, at: Date.now(), returnTo });
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri,
    scope: config.scopes, state, nonce, response_mode: "query",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Completes the login: state check, code exchange, id_token validation. Returns { identity, returnTo }. */
export async function finishLogin(config: OAuthConfig,
  { code, state }: { code: string | null; state: string | null }): Promise<{ identity: Identity; returnTo: string }> {
  const pending = state ? pendingLogins.get(state) : undefined;
  if (state) pendingLogins.delete(state); // single use
  if (!pending || Date.now() - pending.at > LOGIN_TTL_MS) throw new OAuthError("unknown or expired login state");
  if (!code) throw new OAuthError("no authorization code");
  const { token_endpoint: endpoint } = await getMetadata(config);
  if (!endpoint) throw new OAuthError("issuer has no token_endpoint");
  const form = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: config.redirectUri,
    client_id: config.clientId, code_verifier: pending.verifier,
  });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  const tokens = await fetchJson(endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form,
  });
  if (!tokens.id_token) throw new OAuthError("provider returned no id_token");
  const claims = await verifyJwt(tokens.id_token, config, { audience: [config.clientId], nonce: pending.nonce });
  return { identity: identityFromClaims(claims, config), returnTo: pending.returnTo };
}

export function createSession(config: OAuthConfig, identity: Identity): string {
  prune(sessions, v => Date.now() > v.expires);
  const id = randomToken();
  sessions.set(id, { identity, expires: Date.now() + config.sessionTtl * 1000 });
  return id;
}

export function destroySession(id: string): boolean { return sessions.delete(id); }

export const SESSION_COOKIE = "oramcp_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Identity of the browser session cookie, or null (unknown / expired). */
export function sessionFromRequest(req: Pick<IncomingMessage, "headers">): { id: string; identity: Identity } | null {
  const id = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  const s = id ? sessions.get(id) : undefined;
  if (!id || !s) return null;
  if (Date.now() > s.expires) { sessions.delete(id); return null; }
  return { id, identity: s.identity };
}

/** Set-Cookie value; maxAge 0 clears the cookie. Secure when the public URL is https. */
export function sessionCookie(config: OAuthConfig, value: string, maxAge: number): string {
  const secure = /^https:/i.test(config.publicUrl || config.redirectUri) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
