/**
 * Validation for the authorization endpoint, shared by the consent page
 * (GET /oauth/authorize) and the form it submits (POST /api/oauth/authorize)
 * — the POST re-checks everything rather than trusting its hidden fields.
 *
 * RFC 6749 §4.1.2.1 splits failures in two, and the split matters: with an
 * unknown client or an unregistered redirect_uri there is no trustworthy
 * place to send the user, so the error is shown on our own page; everything
 * after that is reported back to the (now verified) redirect_uri.
 */

import { findClient } from "@/lib/oauth/server";
import { publicOrigin, redirectUriMatches, resourceIsOurs, withParams } from "@/lib/oauth/protocol";

export interface AuthorizeParams {
  response_type: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

export const AUTHORIZE_PARAM_NAMES: (keyof AuthorizeParams)[] = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];

export function readAuthorizeParams(get: (name: string) => string | null | undefined): AuthorizeParams {
  const out = {} as AuthorizeParams;
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const v = get(name);
    out[name] = typeof v === "string" && v !== "" ? v : null;
  }
  return out;
}

export type AuthorizeValidation =
  | {
      kind: "ok";
      client: { id: string; client_id: string; client_name: string };
      redirectUri: string;
      codeChallenge: string;
      params: AuthorizeParams;
    }
  /** Shown on our page — no verified redirect_uri to send it to. */
  | { kind: "fatal"; message: string }
  /** Sent back to the client's verified redirect_uri. */
  | { kind: "redirect"; url: string };

export function errorRedirect(
  redirectUri: string,
  state: string | null,
  error: string,
  description?: string
): string {
  return withParams(redirectUri, {
    error,
    error_description: description,
    state: state ?? undefined,
    iss: publicOrigin(),
  });
}

export async function validateAuthorizeRequest(params: AuthorizeParams): Promise<AuthorizeValidation> {
  const client = await findClient(params.client_id);
  if (!client) {
    return {
      kind: "fatal",
      message:
        "This app isn't registered with Interactor CMS. Remove the connector in Claude and add it again.",
    };
  }

  // A client with a single registered URI may omit redirect_uri (§3.1.2.3).
  const redirectUri =
    params.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (!redirectUri || !redirectUriMatches(redirectUri, client.redirect_uris)) {
    return {
      kind: "fatal",
      message: "The app asked to return to an address it never registered, so the request was stopped.",
    };
  }

  const fail = (error: string, description: string): AuthorizeValidation => ({
    kind: "redirect",
    url: errorRedirect(redirectUri, params.state, error, description),
  });

  if (params.response_type !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  }
  // OAuth 2.1 / MCP: PKCE is mandatory, and only S256.
  if (!params.code_challenge) {
    return fail("invalid_request", "code_challenge is required (PKCE).");
  }
  if ((params.code_challenge_method ?? "plain") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256.");
  }
  if (!resourceIsOurs(params.resource)) {
    return fail("invalid_target", "resource must be this CMS's MCP endpoint.");
  }

  return {
    kind: "ok",
    client: { id: client.id, client_id: client.client_id, client_name: client.client_name },
    redirectUri,
    codeChallenge: params.code_challenge,
    params,
  };
}
