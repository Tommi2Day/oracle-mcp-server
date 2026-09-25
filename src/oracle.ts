/**
 * Oracle connection configuration — pure helpers, no driver imports.
 *
 * A connection target can be described in three ways (highest precedence first):
 *   1. connect_string – free form: Easy Connect (Plus), full connect descriptor,
 *                       TNS alias or JDBC URL (jdbc:oracle:thin:@…)
 *   2. tns_alias      – alias resolved from tnsnames.ora in tns_admin / TNS_ADMIN
 *   3. host/port      – classic host, port and service_name (or sid), protocol tcp|tcps
 */
import fs from "node:fs";
import path from "node:path";

/** Connection definition as stored per token and built from ORA_* env vars. */
export interface OraConnection {
  connect_string?: string;
  tns_alias?: string;
  host?: string;
  port?: number | string;
  service_name?: string;
  sid?: string;
  protocol?: string;
  user?: string;
  password?: string;
  tns_admin?: string;
  wallet_location?: string;
  wallet_password?: string;
  ssl_server_dn_match?: boolean | string;
  ssl_server_cert_dn?: string;
  /** Oracle Diagnostics Pack licensed for this database (enables ASH/AWR tools). */
  diagnostics_pack?: boolean | string;
  /** Oracle Tuning Pack licensed for this database (enables SQL Monitor tools). */
  tuning_pack?: boolean | string;
}

/** Subset of oracledb.PoolAttributes produced by resolvePoolAttributes(). */
export interface OraPoolAttributes {
  user?: string;
  password?: string;
  connectString: string;
  configDir?: string;
  walletLocation?: string;
  walletPassword?: string;
  sslServerDNMatch?: boolean;
  sslServerCertDN?: string;
  poolMin: number;
  poolMax: number;
  poolIncrement: number;
  connectTimeout: number;
  poolPingInterval: number;
  /** V$SESSION.PROGRAM (thin mode only) */
  program?: string;
}

export interface ParsedConnectString {
  connectString: string;
  user?: string;
  password?: string;
  configDir?: string;
  /** JDBC-only URL properties (e.g. oracle.net.*) that have no node-oracledb equivalent. */
  ignoredParams: string[];
}

export type DriverMode = "thin" | "thick";

export const DEFAULT_PORT = 1521;

/** Key names that select the connection target. */
const TARGET_KEYS = ["connect_string", "tns_alias", "host"] as const;

const HOST_PORT_SID = /^(\[[0-9a-fA-F:]+\]|[\w.-]+):(\d+):([\w$#.]+)$/;

function isTruthy(v: unknown): boolean {
  return ["true", "1", "yes", "on"].includes(String(v).toLowerCase());
}

/** undefined when v is unset/empty, otherwise the boolean value of v. */
function optBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "boolean" ? v : isTruthy(v);
}

function nonEmpty(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

/** Driver mode from ORA_DRIVER_MODE (thin|thick), default thin. */
/** Performance tool feature switches for a (merged) connection. */
export interface PerfFeatures {
  /** Unlicensed performance tools (plans, V$ views, statistics). ORA_PERF_TOOLS, default true. */
  perf: boolean;
  /** Diagnostics Pack tools (ASH, AWR). diagnostics_pack / ORA_DIAGNOSTICS_PACK, default false. */
  diagnostics: boolean;
  /** Tuning Pack tools (SQL Monitor). tuning_pack / ORA_TUNING_PACK, default false. */
  tuning: boolean;
}

export function perfFeatures(c: OraConnection, env: NodeJS.ProcessEnv = process.env): PerfFeatures {
  const perf = optBool(env.ORA_PERF_TOOLS) ?? true;
  return {
    perf,
    diagnostics: perf && (optBool(c.diagnostics_pack) ?? false),
    tuning:      perf && (optBool(c.tuning_pack) ?? false),
  };
}

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  return (env.ORA_DRIVER_MODE || "thin").toLowerCase() === "thick" ? "thick" : "thin";
}

/**
 * Normalises a free-form connect string for node-oracledb.
 *
 * Accepts
 *   jdbc:oracle:thin:@host:port/service           → host:port/service
 *   jdbc:oracle:thin:@//host:port/service         → host:port/service
 *   jdbc:oracle:thin:@host:port:SID               → (DESCRIPTION=…(SID=SID)…)
 *   jdbc:oracle:thin:@tcps://host:port/service    → tcps://host:port/service
 *   jdbc:oracle:thin:@(DESCRIPTION=…)             → (DESCRIPTION=…)
 *   jdbc:oracle:thin:@alias?TNS_ADMIN=/dir        → alias, configDir=/dir
 *   jdbc:oracle:thin:scott/tiger@…                → user=scott, password=tiger
 * and the same strings without the jdbc: prefix (Easy Connect, descriptors, aliases).
 */
export function parseConnectString(raw: string): ParsedConnectString {
  let s = raw.trim();
  const result: ParsedConnectString = { connectString: "", ignoredParams: [] };

  const jdbc = s.match(/^jdbc:oracle:(?:thin|oci8?|kprb):/i);
  if (jdbc) {
    s = s.slice(jdbc[0].length);
    const at = s.indexOf("@");
    if (at >= 0) {
      const creds = s.slice(0, at);
      s = s.slice(at + 1);
      if (creds) {
        const slash = creds.indexOf("/");
        const user = slash >= 0 ? creds.slice(0, slash) : creds;
        const password = slash >= 0 ? creds.slice(slash + 1) : undefined;
        if (user) result.user = unquote(user);
        if (password) result.password = unquote(password);
      }
    }
  } else if (s.startsWith("@")) {
    s = s.slice(1);
  }

  // URL parameters: after the last ')' for descriptors, anywhere for Easy Connect / aliases
  const paramStart = s.indexOf("?", s.startsWith("(") ? s.lastIndexOf(")") : 0);
  if (paramStart >= 0) {
    const kept: string[] = [];
    for (const pair of s.slice(paramStart + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = eq >= 0 ? pair.slice(0, eq) : pair;
      const value = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : "";
      if (key.toUpperCase() === "TNS_ADMIN") result.configDir = value;
      else if (key.includes(".")) result.ignoredParams.push(key);
      else kept.push(pair);
    }
    s = s.slice(0, paramStart) + (kept.length ? "?" + kept.join("&") : "");
  }

  if (s.startsWith("//")) s = s.slice(2);

  const sid = s.match(HOST_PORT_SID);
  if (sid) {
    s = buildDescriptor("tcp", sid[1].replace(/^\[|\]$/g, ""), sid[2], { sid: sid[3] });
  }

  result.connectString = s;
  return result;
}

/**
 * Moves credentials embedded in a JDBC URL (jdbc:oracle:thin:scott/tiger@…) into the
 * user/password fields so the password can be encrypted at rest and is never echoed.
 * Explicit user/password fields win over the URL values.
 */
export function extractJdbcCredentials(c: OraConnection): OraConnection {
  const cs = c.connect_string;
  const m = cs?.match(/^(\s*jdbc:oracle:(?:thin|oci8?|kprb):)([^@]*)@/i);
  if (!cs || !m || !m[2]) return c;
  const parsed = parseConnectString(cs);
  const out: OraConnection = { ...c, connect_string: m[1] + "@" + cs.slice(m[0].length) };
  if (!out.user && parsed.user) out.user = parsed.user;
  if (!out.password && parsed.password) out.password = parsed.password;
  return out;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith("\"") && s.endsWith("\"") ? s.slice(1, -1) : s;
}

function buildDescriptor(protocol: string, host: string, port: string | number,
  target: { sid?: string; service_name?: string }): string {
  const cd = target.sid ? `(SID=${target.sid})` : `(SERVICE_NAME=${target.service_name ?? ""})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol.toUpperCase()})(HOST=${host})(PORT=${port}))(CONNECT_DATA=${cd}))`;
}

/** Connect string for the host/port/service_name|sid/protocol form. */
export function buildHostConnectString(c: OraConnection): string {
  const host = nonEmpty(c.host);
  if (!host) throw new Error("host is required when neither connect_string nor tns_alias is set");
  const protocol = (nonEmpty(c.protocol) || "tcp").toLowerCase();
  if (protocol !== "tcp" && protocol !== "tcps") throw new Error(`Unsupported protocol "${c.protocol}" (use tcp or tcps)`);
  const port = nonEmpty(c.port) || String(DEFAULT_PORT);
  if (!/^\d+$/.test(port)) throw new Error(`Invalid port "${c.port}"`);
  const sid = nonEmpty(c.sid);
  if (sid) return buildDescriptor(protocol, host, port, { sid });
  const service = nonEmpty(c.service_name);
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol === "tcps" ? "tcps://" : ""}${hostPart}:${port}${service ? "/" + service : ""}`;
}

/** Builds the default connection from ORA_* environment variables. */
export function connectionFromEnv(env: NodeJS.ProcessEnv = process.env): OraConnection {
  const c: OraConnection = {
    connect_string:      nonEmpty(env.ORA_CONNECT_STRING),
    tns_alias:           nonEmpty(env.ORA_TNS_ALIAS),
    host:                nonEmpty(env.ORA_HOST),
    port:                nonEmpty(env.ORA_PORT),
    service_name:        nonEmpty(env.ORA_SERVICE_NAME),
    sid:                 nonEmpty(env.ORA_SID),
    protocol:            nonEmpty(env.ORA_PROTOCOL),
    user:                nonEmpty(env.ORA_USER),
    password:            env.ORA_PASSWORD || undefined,
    tns_admin:           nonEmpty(env.TNS_ADMIN),
    wallet_location:     nonEmpty(env.ORA_WALLET_LOCATION),
    wallet_password:     env.ORA_WALLET_PASSWORD || undefined,
    ssl_server_dn_match: nonEmpty(env.ORA_SSL_SERVER_DN_MATCH),
    ssl_server_cert_dn:  nonEmpty(env.ORA_SSL_SERVER_CERT_DN),
    diagnostics_pack:    nonEmpty(env.ORA_DIAGNOSTICS_PACK),
    tuning_pack:         nonEmpty(env.ORA_TUNING_PACK),
  };
  if (!c.password && env.ORA_PASSWORD_FILE) {
    c.password = fs.readFileSync(env.ORA_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "");
  }
  if (!c.connect_string && !c.tns_alias && !c.host) c.host = "localhost";
  return stripUndefined(c);
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Merges a per-token connection with the server default.
 * The target (connect_string | tns_alias | host/port/…) is taken as a whole from the
 * token when it defines one, so fields of different target types are never mixed.
 * Credentials fall back to the default only when the token does not set a user.
 * TNS_ADMIN, wallet and TLS settings fall back individually.
 */
export function mergeConnection(token: OraConnection | null | undefined, base: OraConnection): OraConnection {
  if (!token) return { ...base };
  const tokenHasTarget = TARGET_KEYS.some(k => nonEmpty(token[k]));
  const merged: OraConnection = {};

  const targetSrc = tokenHasTarget ? token : base;
  for (const k of ["connect_string", "tns_alias", "host", "port", "service_name", "sid", "protocol"] as const) {
    if (targetSrc[k] !== undefined && targetSrc[k] !== "") merged[k] = targetSrc[k] as never;
  }

  if (nonEmpty(token.user)) {
    merged.user = token.user;
    if (token.password) merged.password = token.password;
  } else {
    if (base.user) merged.user = base.user;
    if (token.password || base.password) merged.password = token.password || base.password;
  }

  for (const k of ["tns_admin", "wallet_location", "wallet_password", "ssl_server_dn_match", "ssl_server_cert_dn",
    "diagnostics_pack", "tuning_pack"] as const) {
    const v = token[k] !== undefined && token[k] !== "" ? token[k] : base[k];
    if (v !== undefined && v !== "") merged[k] = v as never;
  }
  return merged;
}

/** Final connect string for a (merged) connection, plus credentials/configDir found in a JDBC URL. */
export function resolveConnectString(c: OraConnection): ParsedConnectString {
  const cs = nonEmpty(c.connect_string);
  if (cs) return parseConnectString(cs);
  const alias = nonEmpty(c.tns_alias);
  if (alias) return { connectString: alias, ignoredParams: [] };
  return { connectString: buildHostConnectString(c), ignoredParams: [] };
}

/** True when the connect string targets a TCPS endpoint. */
export function usesTcps(connectString: string): boolean {
  return /^tcps:\/\//i.test(connectString) || /\(\s*PROTOCOL\s*=\s*TCPS\s*\)/i.test(connectString);
}

/**
 * Content of <dir>/ewallet.pem:
 *   key  – private key + certificates (mTLS / Autonomous DB wallet) → thin walletLocation
 *   ca   – certificates only (trust store for a private CA)        → trusted CA certificates
 *   none – missing or unreadable
 */
export type WalletKind = "key" | "ca" | "none";

export function inspectWallet(dir: string): WalletKind {
  try {
    const pem = fs.readFileSync(path.join(dir, "ewallet.pem"), "utf8");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return "key";
    return /-----BEGIN CERTIFICATE-----/.test(pem) ? "ca" : "none";
  } catch {
    return "none";
  }
}

export interface ResolveOptions {
  mode?: DriverMode;
  poolMax?: number;
  connectTimeout?: number;
  inspectWallet?: (dir: string) => WalletKind;
  /** V$SESSION.PROGRAM, thin mode only (see programName()) */
  program?: string;
}

interface WalletResolution {
  walletLocation?: string;
  caFile?: string;
}

/**
 * Thin mode wallet handling. node-oracledb thin loads ewallet.pem as client
 * cert + key + CA, which fails for a certificate-only PEM. Such files are
 * therefore returned as caFile (to be added to the trusted CA set) instead.
 * An explicit wallet_location is passed through unless it is certificate-only;
 * TNS_ADMIN (configDir) is only used as wallet when its ewallet.pem has a key.
 */
function resolveWallet(c: OraConnection, configDir: string | undefined, inspect: (d: string) => WalletKind): WalletResolution {
  const explicit = nonEmpty(c.wallet_location);
  if (explicit) {
    return inspect(explicit) === "ca" ? { caFile: path.join(explicit, "ewallet.pem") } : { walletLocation: explicit };
  }
  if (!configDir) return {};
  const kind = inspect(configDir);
  if (kind === "key") return { walletLocation: configDir };
  if (kind === "ca") return { caFile: path.join(configDir, "ewallet.pem") };
  return {};
}

/** Certificate-only ewallet.pem that must be trusted for this connection (thin mode), if any. */
export function trustedCaFile(c: OraConnection, opts: ResolveOptions = {}): string | undefined {
  if ((opts.mode ?? "thin") !== "thin") return undefined;
  const configDir = resolveConnectString(c).configDir ?? nonEmpty(c.tns_admin);
  return resolveWallet(c, configDir, opts.inspectWallet ?? inspectWallet).caFile;
}

/**
 * Pool attributes for node-oracledb.
 * Thin mode: configDir (tnsnames.ora), walletLocation (ewallet.pem with key) and
 * TLS DN options are passed explicitly (see resolveWallet()).
 * Thick mode: all network configuration comes from TNS_ADMIN (tnsnames.ora,
 * sqlnet.ora, cwallet.sso) via initOracleClient(), so those attributes are omitted.
 */
export function resolvePoolAttributes(c: OraConnection, opts: ResolveOptions = {}): OraPoolAttributes {
  const mode = opts.mode ?? "thin";
  const parsed = resolveConnectString(c);
  const attrs: OraPoolAttributes = {
    user:             parsed.user ?? c.user,
    password:         parsed.password ?? c.password,
    connectString:    parsed.connectString,
    poolMin:          0,
    poolMax:          opts.poolMax ?? 5,
    poolIncrement:    1,
    connectTimeout:   opts.connectTimeout ?? 10,
    poolPingInterval: 60,
  };
  if (mode === "thin") {
    const configDir = parsed.configDir ?? nonEmpty(c.tns_admin);
    if (configDir) attrs.configDir = configDir;
    const { walletLocation } = resolveWallet(c, configDir, opts.inspectWallet ?? inspectWallet);
    if (walletLocation) attrs.walletLocation = walletLocation;
    if (c.wallet_password) attrs.walletPassword = c.wallet_password;
    const dnMatch = optBool(c.ssl_server_dn_match);
    if (dnMatch !== undefined) attrs.sslServerDNMatch = dnMatch;
    const certDn = nonEmpty(c.ssl_server_cert_dn);
    if (certDn) attrs.sslServerCertDN = certDn;
    if (opts.program) attrs.program = opts.program;
  }
  return stripUndefined(attrs);
}

/** Password-free description of a connection for /info, logs and the admin UI. */
export function describeConnection(c: OraConnection, mode: DriverMode = "thin"): Record<string, unknown> {
  let connectString: string;
  let error: string | undefined;
  try {
    connectString = resolveConnectString(c).connectString;
  } catch (err) {
    connectString = "";
    error = (err as Error).message;
  }
  const type = nonEmpty(c.connect_string) ? "connect_string" : nonEmpty(c.tns_alias) ? "tns_alias" : "host";
  return stripUndefined({
    type,
    connect_string: redactConnectString(connectString),
    host:           type === "host" ? c.host : undefined,
    port:           type === "host" ? Number(c.port || DEFAULT_PORT) : undefined,
    service_name:   type === "host" ? c.service_name : undefined,
    sid:            type === "host" ? c.sid : undefined,
    tns_alias:      type === "tns_alias" ? c.tns_alias : undefined,
    // an alias' protocol is only known from tnsnames.ora
    protocol:       !connectString || type === "tns_alias" ? undefined : usesTcps(connectString) ? "tcps" : "tcp",
    user:           c.user,
    tns_admin:      c.tns_admin,
    wallet:         c.wallet_location,
    driver_mode:    mode,
    error,
  });
}

/** Removes a wallet password that may appear in Easy Connect Plus parameters. */
export function redactConnectString(s: string): string {
  return s.replace(/(wallet_password\s*=\s*)[^&)\s]+/gi, "$1***");
}

/**
 * Oracle rejects a trailing ';' on SQL statements (ORA-00933/ORA-00911) but PL/SQL
 * blocks require it. Strips a trailing ';' from SQL and a trailing SQL*Plus '/' line
 * from PL/SQL.
 */
export function normalizeSql(sql: string): string {
  let s = sql.trim();
  s = s.replace(/\n\s*\/\s*$/, "").trim();
  if (isPlsql(s)) return s;
  return s.replace(/;\s*$/, "").trim();
}

export function isPlsql(sql: string): boolean {
  const s = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").toUpperCase();
  if (/^(BEGIN|DECLARE)\b/.test(s)) return true;
  return /^CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY)\b/.test(s);
}

/** First keyword of a statement (upper-case), skipping whitespace, comments and '('. */
export function firstKeyword(sql: string): string {
  const s = sql.replace(/^(\s|\(|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  return (s.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
}

/** Oracle identifier semantics: "Quoted" is used verbatim, anything else is upper-cased. */
export function toIdentifier(name: string | undefined | null): string | null {
  if (name === undefined || name === null) return null;
  const s = String(name).trim();
  if (!s) return null;
  if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) return s.slice(1, -1);
  return s.toUpperCase();
}

// ── Session identification (V$SESSION) ─────────────────────────────────────────
/** Who is using a pooled connection: MCP server, token and tool. */
export interface SessionContext {
  server: string;
  version: string;
  token: string;
  ip: string;
  tool: string;
}

/** End-to-end tracing attributes shown in V$SESSION, ASH and the audit trail. */
export interface SessionTags {
  module: string;      // V$SESSION.MODULE            – MCP server name
  action: string;      // V$SESSION.ACTION            – tool name
  clientId: string;    // V$SESSION.CLIENT_IDENTIFIER – token name
  clientInfo: string;  // V$SESSION.CLIENT_INFO       – server, version, client IP
}

/** Cuts a string to at most maxBytes UTF-8 bytes without splitting a character. */
export function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, "utf8") > maxBytes) break;
    out += ch;
  }
  return out;
}

/** Tags within Oracle's limits (MODULE 48, ACTION 32, CLIENT_IDENTIFIER / CLIENT_INFO 64 bytes). */
export function sessionTags(ctx: SessionContext): SessionTags {
  return {
    module:     truncateBytes(ctx.server, 48),
    action:     truncateBytes(ctx.tool, 32),
    clientId:   truncateBytes(ctx.token, 64),
    clientInfo: truncateBytes(`${ctx.server} ${ctx.version} ip=${ctx.ip}`, 64),
  };
}

/** V$SESSION.PROGRAM value (thin mode): the server name reduced to characters the driver accepts. */
export function programName(server: string): string {
  return server.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "oracle-mcp-server";
}
