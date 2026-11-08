import { NextResponse } from "next/server";
import { OAuthError } from "@/lib/oauth/server";

/**
 * CORS + caching headers for the OAuth protocol endpoints. They carry no
 * cookies and every credential they accept is in the request itself, so an
 * open origin is safe — and browser-based MCP clients (e.g. the MCP
 * Inspector) need it to discover and register at all.
 */
export const OAUTH_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache", ...extra },
  });
}

export function oauthErrorResponse(err: unknown) {
  if (err instanceof OAuthError) {
    return oauthJson(
      { error: err.code, error_description: err.description },
      err.status,
      err.status === 401 ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {}
    );
  }
  console.error("[cms-oauth]", err);
  return oauthJson({ error: "server_error", error_description: "Unexpected error." }, 500);
}

export function preflight() {
  return new NextResponse(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
