import { NextRequest, NextResponse } from "next/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { verifyApiTokenValue } from "@/lib/guard";
import { protectedResourceMetadataUrl } from "@/lib/oauth/protocol";
import { MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS, registerCmsTools } from "@/lib/mcp/tools";

/**
 * Remote MCP server (Streamable HTTP, stateless) for LLM clients — Claude
 * Code, Claude Desktop, or any MCP client — to manage CMS content.
 *
 * Auth: the caller's personal access token (`Authorization: Bearer
 * cms_pat_...`, minted at /settings/tokens). The token is verified here
 * before any JSON-RPC handling — a missing, malformed, unknown, revoked, or
 * expired token gets HTTP 401 (createMcpHandler itself is deliberately
 * auth-free; authInfo is pass-through). Each tool then delegates to the
 * corresponding /api/cms route handler with that same bearer
 * (src/lib/mcp/tools.ts), so fine-grained RBAC, tenancy, sanitization and
 * the publish gate are the REST API's own — the MCP layer never
 * re-implements or bypasses them.
 *
 * Or an OAuth access token from the connector flow (src/lib/oauth/): the
 * 401 below carries `resource_metadata`, which is how Claude discovers the
 * CMS's authorization server and signs the user in with no token pasting.
 * Those access tokens ARE `cms_pat_` rows, so nothing below distinguishes them.
 *
 * Connect from Claude (web/desktop/mobile): Settings → Connectors → Add custom
 * connector → https://<host>/api/mcp. From Claude Code:
 *   claude mcp add --transport http cms https://<host>/api/mcp
 * (then /mcp to sign in), or with a PAT:
 *   claude mcp add --transport http cms https://<host>/api/mcp \
 *     --header "Authorization: Bearer cms_pat_..."
 */

const handler = createMcpHandler(() => {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: MCP_SERVER_INSTRUCTIONS });
  registerCmsTools(server);
  return server;
});

export async function POST(req: NextRequest): Promise<Response> {
  // RFC 7235 makes the auth scheme case-insensitive; downstream delegation
  // re-sends the token with the canonical "Bearer " prefix either way.
  const match = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  const raw = match?.[1].trim() ?? null;
  // Only "is this a live token, and whose": which organization a call acts in
  // is decided per tool call by the route it delegates to (a workspace
  // connection names it with each call; see src/lib/workspaces.ts).
  const auth = raw ? await verifyApiTokenValue(raw) : null;
  if (!raw || !auth) {
    return NextResponse.json(
      {
        error:
          "Unauthorized: sign in via OAuth (add this URL as a connector in Claude) or pass a personal access token as 'Authorization: Bearer cms_pat_...'",
      },
      {
        status: 401,
        headers: {
          // RFC 9728 §5.1 — the pointer MCP clients follow to find our
          // authorization server and start the sign-in flow.
          "WWW-Authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`,
        },
      }
    );
  }

  return handler.fetch(req, {
    authInfo: {
      token: raw,
      clientId: auth.userId,
      scopes: [],
      extra: { userId: auth.userId, tokenId: auth.tokenId },
    },
  });
}

// No GET/DELETE exports: the stateless handler has no SSE stream to offer and
// no session to terminate, so Next's own 405 is the right (and cheapest)
// answer — it avoids paying token verification just to refuse a probe.
