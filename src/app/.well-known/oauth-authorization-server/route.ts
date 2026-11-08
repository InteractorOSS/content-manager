import { authorizationServerMetadata } from "@/lib/oauth/protocol";
import { OAUTH_CORS_HEADERS, preflight } from "@/lib/oauth/http";

/** RFC 8414 authorization server metadata for the MCP connector. */
export function GET() {
  return Response.json(authorizationServerMetadata(), { headers: OAUTH_CORS_HEADERS });
}

export const OPTIONS = preflight;
