import type { NextRequest } from "next/server";
import {
  handleChannelConnectCallback,
  recoverJoinedCallbackParams,
} from "@/lib/social/connect-callback";

/**
 * Compatibility shim for connect flows started before the id moved into the
 * path (see ./[channelId]/route.ts). Core still holds the old
 * `success_redirect_url` for any handshake already in flight, so those come
 * back here — usually with our query string and Core's welded together into
 * one `channel_id` value. Both ids are recovered from that and the same
 * authenticated, org-scoped activation runs.
 *
 * Keep it until no pending channel predates the path-based redirect; new flows
 * never reach it.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  return handleChannelConnectCallback(
    req,
    recoverJoinedCallbackParams(
      params.get("channel_id"),
      params.get("credential_id")
    )
  );
}
