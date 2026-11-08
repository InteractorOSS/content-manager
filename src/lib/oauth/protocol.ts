/**
 * Pure OAuth 2.1 helpers for the MCP connector — no Prisma, no next/*, so
 * every rule here is unit-tested directly (protocol.test.ts).
 *
 * Why the CMS is its own authorization server rather than pointing Claude at
 * auth.interactor.com: an Interactor token names a person but not a CMS
 * organization (every CMS token is bound to exactly one — see ApiToken in
 * prisma/schema.prisma), auth.interactor.com offers no dynamic client
 * registration, and it has no public-client support. Doing it here means a
 * Claude user pastes one URL and clicks Connect; sign-in itself is still
 * Interactor SSO, because the consent page sits behind the ordinary CMS
 * session.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

/** Access tokens are short-lived; the client refreshes silently. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Refresh tokens slide: each refresh pushes the connection's expiry out again. */
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Authorization codes are single-use and live just long enough for a redirect. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;

export const SUPPORTED_SCOPE = "cms";
export const TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_post",
  "client_secret_basic",
] as const;
export type TokenEndpointAuthMethod = (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];

const REFRESH_TOKEN_PREFIX = "cms_rt_";
const CLIENT_SECRET_PREFIX = "cms_cs_";

/** The public origin this app is served on — the issuer, and the resource's origin. */
export function publicOrigin(): string {
  return new URL(env.NEXTAUTH_URL).origin;
}

/** The protected resource the connector talks to: the MCP endpoint. */
export function mcpResourceUrl(origin = publicOrigin()): string {
  return `${origin}/api/mcp`;
}

/** Where the MCP 401 points clients for discovery (RFC 9728 §3.1 path-suffixed form). */
export function protectedResourceMetadataUrl(origin = publicOrigin()): string {
  return `${origin}/.well-known/oauth-protected-resource/api/mcp`;
}

export function protectedResourceMetadata(origin = publicOrigin()) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SUPPORTED_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Interactor CMS",
    resource_documentation: `${origin}/docs`,
  };
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(origin = publicOrigin()) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    scopes_supported: [SUPPORTED_SCOPE],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/docs`,
  };
}

// ─── Secrets ────────────────────────────────────────────────────────────────

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateRefreshToken(): string {
  return `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generateClientSecret(): string {
  return `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generateAuthorizationCode(): string {
  return randomBytes(32).toString("base64url");
}

export function generateClientId(): string {
  return `cms_client_${randomBytes(16).toString("hex")}`;
}

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. Plain is not accepted. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  // §4.1: 43–128 chars from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Redirect URIs ──────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Is this redirect URI acceptable at registration? https anywhere, or http on
 * a loopback host only (a native client like Claude Code catching the code on
 * a local port, RFC 8252 §7.3). No fragments; no userinfo.
 */
export function registrableRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && isLoopback(url)) return raw;
  return null;
}

/**
 * Does the redirect_uri on an authorize request match one the client
 * registered? Exact string match, except that a loopback URI may differ in
 * port (RFC 8252 §7.3) — a native client picks a free port per sign-in.
 */
export function redirectUriMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !isLoopback(req)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === "http:" &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

/** Append query params to a redirect URI, preserving any it already carries. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * A `resource` (RFC 8707) is accepted when it names something on this origin
 * — the MCP URL as the user pasted it may carry a trailing slash or none, and
 * the token is a CMS token either way. A foreign resource is refused so a
 * token is never minted for an audience that isn't us.
 */
export function resourceIsOurs(resource: string | null | undefined, origin = publicOrigin()): boolean {
  if (!resource) return true;
  try {
    return new URL(resource).origin === origin;
  } catch {
    return false;
  }
}

// ─── Dynamic client registration (RFC 7591) ─────────────────────────────────

export interface ClientRegistration {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
}

export type RegistrationResult =
  | { ok: true; value: ClientRegistration }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;

export function parseClientRegistration(body: unknown): RegistrationResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_client_metadata", description: "Body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.redirect_uris) || b.redirect_uris.length === 0) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris is required." };
  }
  if (b.redirect_uris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: `At most ${MAX_REDIRECT_URIS} redirect_uris.`,
    };
  }
  const redirect_uris: string[] = [];
  for (const raw of b.redirect_uris) {
    const ok = registrableRedirectUri(raw);
    if (!ok) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description: `Unacceptable redirect_uri ${JSON.stringify(raw)}: use https, or http on localhost.`,
      };
    }
    redirect_uris.push(ok);
  }

  // RFC 7591 §2 defaults this to client_secret_basic; MCP clients send "none".
  const method = b.token_endpoint_auth_method ?? "client_secret_basic";
  if (!TOKEN_ENDPOINT_AUTH_METHODS.includes(method as TokenEndpointAuthMethod)) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: `Unsupported token_endpoint_auth_method ${JSON.stringify(method)}.`,
    };
  }

  if (b.grant_types !== undefined) {
    const allowed = new Set(["authorization_code", "refresh_token"]);
    if (!Array.isArray(b.grant_types) || b.grant_types.some((g) => !allowed.has(g as string))) {
      return {
        ok: false,
        error: "invalid_client_metadata",
        description: "Only the authorization_code and refresh_token grant types are supported.",
      };
    }
  }
  if (b.response_types !== undefined) {
    if (!Array.isArray(b.response_types) || b.response_types.some((r) => r !== "code")) {
      return { ok: false, error: "invalid_client_metadata", description: "Only response_type code is supported." };
    }
  }

  const rawName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const client_name = (rawName || "MCP client").slice(0, MAX_CLIENT_NAME);

  return {
    ok: true,
    value: {
      client_name,
      redirect_uris,
      token_endpoint_auth_method: method as TokenEndpointAuthMethod,
    },
  };
}

// ─── Client authentication at the token endpoint ────────────────────────────

export interface PresentedClientCredentials {
  client_id: string | null;
  client_secret: string | null;
  /** Which method the request actually used, to check against the registration. */
  method: TokenEndpointAuthMethod;
}

/**
 * Read client credentials off a token/revoke request: HTTP Basic takes
 * precedence (RFC 6749 §2.3.1), then form-body client_secret, else a public
 * client identifying itself by client_id alone.
 */
export function presentedClientCredentials(
  authorizationHeader: string | null,
  form: URLSearchParams
): PresentedClientCredentials {
  const basic = authorizationHeader?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep > 0) {
      return {
        client_id: decodeURIComponent(decoded.slice(0, sep)),
        client_secret: decodeURIComponent(decoded.slice(sep + 1)),
        method: "client_secret_basic",
      };
    }
  }
  const secret = form.get("client_secret");
  return {
    client_id: form.get("client_id"),
    client_secret: secret,
    method: secret ? "client_secret_post" : "none",
  };
}

/** Parse a token-endpoint body: form-encoded per spec, JSON tolerated. */
export async function readFormBody(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const json = await req.json().catch(() => ({}));
    const params = new URLSearchParams();
    if (json && typeof json === "object") {
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (typeof v === "string") params.set(k, v);
      }
    }
    return params;
  }
  return new URLSearchParams(await req.text().catch(() => ""));
}
