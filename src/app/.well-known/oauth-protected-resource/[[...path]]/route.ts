import { protectedResourceMetadata } from "@/lib/oauth/protocol";
import { OAUTH_CORS_HEADERS, preflight } from "@/lib/oauth/http";

/**
 * RFC 9728 protected resource metadata. Served both at the bare path and the
 * path-suffixed form (`/.well-known/oauth-protected-resource/api/mcp`) that
 * the MCP endpoint's 401 points to — clients probe either.
 */
export function GET() {
  return Response.json(protectedResourceMetadata(), { headers: OAUTH_CORS_HEADERS });
}

export const OPTIONS = preflight;
