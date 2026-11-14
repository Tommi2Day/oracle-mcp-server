import crypto from "node:crypto";
import { vi } from "vitest";

export const ISSUER = "https://idp.test/tenant/v2.0";
export const AUDIENCE = "api://oracle-mcp";
export const CLIENT_ID = "client-1";

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

export interface SignOptions { alg?: string; kid?: string | null; key?: crypto.KeyObject; header?: Record<string, unknown> }

/** A fake identity provider: RSA key pair, JWT signing and a `fetch` stub for discovery, JWKS and token endpoint. */
export function makeIdp({ issuer = ISSUER } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" } as Record<string, unknown>;
  const idp = {
    issuer, jwk, keys: [jwk], hits: { jwks: 0, discovery: 0, token: 0 },
    tokenResponse: null as null | ((body: URLSearchParams) => unknown),
    lastTokenRequest: undefined as URLSearchParams | undefined,
    privateKey,
    /** Signs claims as JWT; defaults make a valid access token for AUDIENCE. */
    sign(claims: Record<string, unknown> = {}, { alg = "RS256", kid = "k1", key = privateKey, header = {} }: SignOptions = {}): string {
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: AUDIENCE, sub: "sub-1", iat: now, exp: now + 600, ...claims };
      const h = b64({ alg, typ: "JWT", ...(kid && { kid }), ...header });
      const input = `${h}.${b64(payload)}`;
      if (alg === "none") return `${input}.`;
      if (alg.startsWith("HS")) return `${input}.${crypto.createHmac("sha256", "x").update(input).digest("base64url")}`;
      let sig: Buffer;
      if (alg.startsWith("PS")) {
        sig = crypto.sign("sha256", Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
      } else if (alg.startsWith("ES")) {
        sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
      } else {
        sig = crypto.sign("sha256", Buffer.from(input), key);
      }
      return `${input}.${sig.toString("base64url")}`;
    },
    fetch: vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url);
      const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
      if (u === `${issuer}/.well-known/openid-configuration`) {
        idp.hits.discovery++;
        return json({ issuer, jwks_uri: `${issuer}/keys`, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
      }
      if (u === `${issuer}/keys`) { idp.hits.jwks++; return json({ keys: idp.keys }); }
      if (u === `${issuer}/token` && init.method === "POST") {
        idp.hits.token++;
        idp.lastTokenRequest = new URLSearchParams(String(init.body));
        return idp.tokenResponse ? idp.tokenResponse(idp.lastTokenRequest) : json({ error: "invalid_grant", error_description: "bad code" }, 400);
      }
      return json({ error: "not found" }, 404);
    }) as any,
  };
  return idp;
}

/** Sets OAUTH_* env vars for a test (clearing others); returns a restore function. */
export function setOAuthEnv(extra: Record<string, string> = {}): () => void {
  const env = {
    OAUTH_ISSUER: ISSUER, OAUTH_AUDIENCE: AUDIENCE, OAUTH_CLIENT_ID: CLIENT_ID,
    OAUTH_PUBLIC_URL: "https://mcp.test", ...extra,
  };
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env).filter(k => k.startsWith("OAUTH_"))) { before[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  return () => {
    for (const k of Object.keys(process.env).filter(k => k.startsWith("OAUTH_"))) delete process.env[k];
    for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
  };
}
