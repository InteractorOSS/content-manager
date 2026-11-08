import type { NextRequest } from "next/server";
import { parseClientRegistration } from "@/lib/oauth/protocol";
import { registerClient } from "@/lib/oauth/server";
import { oauthErrorResponse, oauthJson, preflight } from "@/lib/oauth/http";

/**
 * RFC 7591 dynamic client registration — how Claude (and any MCP client)
 * gets a client_id without anyone pre-registering it. Open by design: a
 * registered client can do nothing until a signed-in member approves it on
 * /oauth/authorize, and that page names the app and where it will redirect.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = parseClientRegistration(body);
  if (!parsed.ok) {
    return oauthJson({ error: parsed.error, error_description: parsed.description }, 400);
  }
  try {
    const { client, secret } = await registerClient(parsed.value);
    return oauthJson(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(client.inserted_at.getTime() / 1000),
        ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201
    );
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const OPTIONS = preflight;
