import type { NextRequest } from "next/server";
import { presentedClientCredentials, readFormBody } from "@/lib/oauth/protocol";
import { authenticateClient, revokeToken } from "@/lib/oauth/server";
import { oauthErrorResponse, oauthJson, preflight } from "@/lib/oauth/http";

/** RFC 7009 token revocation — disconnects the connection the token belongs to. */
export async function POST(req: NextRequest) {
  try {
    const form = await readFormBody(req);
    const client = await authenticateClient(
      presentedClientCredentials(req.headers.get("authorization"), form)
    );
    await revokeToken({ client, token: form.get("token") });
    return oauthJson({});
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const OPTIONS = preflight;
