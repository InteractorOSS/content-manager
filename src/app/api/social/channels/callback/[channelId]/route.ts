import type { NextRequest } from "next/server";
import { handleChannelConnectCallback } from "@/lib/social/connect-callback";

/**
 * Landing point for Interactor Core's hosted-OAuth success redirect:
 *
 *   /api/social/channels/callback/<channelId>?credential_id=<interactor>
 *
 * The channel id rides in the PATH on purpose. It used to ride in a query
 * string we handed Core as part of `success_redirect_url`; Core appends its own
 * `?credential_id=...` to whatever it is given, so our value arrived as the
 * literal `"<channelId>?credential_id=<cred>"` and no channel could ever be
 * connected. A path segment is immune to that join whatever character Core
 * picks. (Core's own fix is their G#43 — this side must not wait for it.)
 *
 * All the work — session, org scoping, credential verification — is in
 * src/lib/social/connect-callback.ts, shared with the legacy query-string
 * route next door.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ channelId: string }> }
) {
  const { channelId } = await ctx.params;
  return handleChannelConnectCallback(req, {
    channelId: channelId || null,
    credentialId: req.nextUrl.searchParams.get("credential_id"),
    providerError: req.nextUrl.searchParams.get("error"),
  });
}
