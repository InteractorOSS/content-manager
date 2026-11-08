import type { NextRequest } from "next/server";
import { presentedClientCredentials, readFormBody } from "@/lib/oauth/protocol";
import {
  OAuthError,
  authenticateClient,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "@/lib/oauth/server";
import { oauthErrorResponse, oauthJson, preflight } from "@/lib/oauth/http";

/** RFC 6749 §3.2 token endpoint: authorization_code (+PKCE) and refresh_token grants. */
export async function POST(req: NextRequest) {
  try {
    const form = await readFormBody(req);
    const client = await authenticateClient(
      presentedClientCredentials(req.headers.get("authorization"), form)
    );

    switch (form.get("grant_type")) {
      case "authorization_code":
        return oauthJson(
          await exchangeAuthorizationCode({
            client,
            code: form.get("code"),
            redirectUri: form.get("redirect_uri"),
            codeVerifier: form.get("code_verifier"),
          })
        );
      case "refresh_token":
        return oauthJson(
          await refreshAccessToken({ client, refreshToken: form.get("refresh_token") })
        );
      default:
        throw new OAuthError(
          "unsupported_grant_type",
          "Supported grant types: authorization_code, refresh_token."
        );
    }
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export const OPTIONS = preflight;
