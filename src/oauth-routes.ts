/**
 * HTTP routes of the OAuth integration (index.ts delegates /auth/* and the protected-resource metadata here):
 *   GET /auth/status                          – public: is OAuth on, who is logged in (Admin UI)
 *   GET /auth/login                           – redirect to the identity provider (authorization code + PKCE)
 *   GET /auth/callback                        – code exchange, creates the session cookie, redirects to /admin
 *   POST /auth/logout                         – ends the session
 *   GET /.well-known/oauth-protected-resource – RFC 9728 metadata for MCP clients
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getOAuthConfig, browserLoginEnabled, startLogin, finishLogin, createSession, destroySession,
  sessionFromRequest, sessionCookie, resolveAccess, safeLogValue,
} from "./oauth.js";
import { log, audit, getClientIp, allAssignments } from "./lib.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  res.end();
}

function authStatus(req: IncomingMessage, res: ServerResponse): void {
  const oauth = getOAuthConfig();
  if (!oauth) { json(res, 200, { enabled: false }); return; }
  const session = sessionFromRequest(req);
  const access = session ? resolveAccess(session.identity, allAssignments()) : null;
  json(res, 200, {
    enabled: true,
    login: browserLoginEnabled(oauth),
    authenticated: !!session,
    user: session ? { email: session.identity.email, name: session.identity.name } : null,
    admin: !!access?.admin,
  });
}

async function authLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const oauth = getOAuthConfig();
  if (!browserLoginEnabled(oauth)) {
    json(res, 404, { error: "Browser login is not configured (OAUTH_CLIENT_ID, OAUTH_PUBLIC_URL)" });
    return;
  }
  try {
    redirect(res, await startLogin(oauth, "/admin"));
  } catch (err) {
    log("error", "AUTH", `result="error" action="GET /auth/login" ip="${getClientIp(req)}" error=${JSON.stringify((err as Error).message)}`);
    json(res, 502, { error: "Identity provider not reachable" });
  }
}

async function authCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const oauth = getOAuthConfig();
  const ip = getClientIp(req);
  if (!browserLoginEnabled(oauth)) { json(res, 404, { error: "Browser login is not configured" }); return; }
  const q = new URL(req.url || "/", "http://x").searchParams;
  if (q.get("error")) {
    log("warn", "AUTH", `result="denied" action="GET /auth/callback" ip="${ip}" reason=${JSON.stringify(`oauth: provider error ${safeLogValue(q.get("error"))}`)}`);
    json(res, 401, { error: "Login failed" });
    return;
  }
  try {
    const { identity, returnTo } = await finishLogin(oauth, { code: q.get("code"), state: q.get("state") });
    const access = resolveAccess(identity, allAssignments());
    if (!access.allowed) {
      log("warn", "AUTH", `result="denied" token="${identity.display}" action="GET /auth/callback" ip="${ip}" reason="oauth: no assignment for this user or groups"`);
      json(res, 403, { error: "No access: user or groups are not assigned to this server" });
      return;
    }
    const sid = createSession(oauth, identity);
    audit({ user: identity.display, sub: identity.sub, action: "login", via: "oauth-browser", admin: access.admin, ip });
    redirect(res, returnTo, { "Set-Cookie": sessionCookie(oauth, sid, oauth.sessionTtl) });
  } catch (err) {
    log("warn", "AUTH", `result="denied" action="GET /auth/callback" ip="${ip}" reason=${JSON.stringify(`oauth: ${safeLogValue((err as Error).message, 200)}`)}`);
    json(res, 401, { error: "Login failed" });
  }
}

function authLogout(req: IncomingMessage, res: ServerResponse): void {
  const oauth = getOAuthConfig();
  const session = sessionFromRequest(req);
  if (session) {
    destroySession(session.id);
    audit({ user: session.identity.display, sub: session.identity.sub, action: "logout", via: "oauth-browser", ip: getClientIp(req) });
  }
  json(res, 200, { ok: true }, oauth ? { "Set-Cookie": sessionCookie(oauth, "", 0) } : {});
}

function protectedResource(_req: IncomingMessage, res: ServerResponse): void {
  const oauth = getOAuthConfig();
  if (!oauth) { json(res, 404, { error: "Not found" }); return; }
  json(res, 200, {
    resource: oauth.publicUrl ? `${oauth.publicUrl}/mcp` : undefined,
    authorization_servers: [oauth.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: oauth.resourceScopes,
  });
}

const ROUTES = new Map<string, Handler>([
  ["GET /auth/status", authStatus],
  ["GET /auth/login", authLogin],
  ["GET /auth/callback", authCallback],
  ["POST /auth/logout", authLogout],
  ["GET /.well-known/oauth-protected-resource", protectedResource],
]);

/** Returns true when the request was an OAuth route (and has been answered). */
export async function handleOAuthRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  const handler = ROUTES.get(`${req.method} ${pathname}`);
  if (!handler) return false;
  await handler(req, res);
  return true;
}
