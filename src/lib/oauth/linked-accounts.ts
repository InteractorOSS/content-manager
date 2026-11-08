import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

// "Add another account" on the connector's consent page. A workspace
// connection may cover several CMS accounts (a work and a personal one), and
// each must sign in to be added. The browser can hold only one CMS session at
// a time, so the accounts that have already approved are carried across the
// sign-out/sign-in in this cookie:
//
//   - signed with the server secret, so it can't be forged or edited;
//   - httpOnly and set only by our own consent submit, so a link someone
//     sends can't plant it: adding an account always starts from a consent
//     page the person is looking at, in their own browser;
//   - bound to the one authorization request (client_id + code_challenge),
//     so it can't be carried into another app's sign-in;
//   - short-lived.
//
// Every account in it proved itself by signing in, in this browser, during
// this one authorization. The token exchange (issueWorkspaceConnection) still
// re-checks that each is a real user with a membership.

export const LINKED_ACCOUNTS_COOKIE = "cms_oauth_accounts";
export const LINKED_ACCOUNTS_TTL_MS = 15 * 60 * 1000;

type Payload = { ids: string[]; client: string; challenge: string; exp: number };

function sign(body: string): string {
  return createHmac("sha256", `${env.NEXTAUTH_SECRET}:oauth-linked-accounts`).update(body).digest("base64url");
}

export function encodeLinkedAccounts(ids: string[], request: { client_id: string; code_challenge: string }, now = Date.now()): string {
  const payload: Payload = {
    ids: [...new Set(ids)].slice(0, 10),
    client: request.client_id,
    challenge: request.code_challenge,
    exp: now + LINKED_ACCOUNTS_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The account ids already added for THIS authorization request, or []. */
export function decodeLinkedAccounts(
  value: string | undefined | null,
  request: { client_id: string | null; code_challenge: string | null },
  now = Date.now()
): string[] {
  if (!value) return [];
  const [body, mac] = value.split(".");
  if (!body || !mac) return [];
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return [];
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    if (p.exp < now || p.client !== request.client_id || p.challenge !== request.code_challenge) return [];
    return Array.isArray(p.ids) ? p.ids.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The accounts on the connection being approved: earlier ones, then the signed-in one. */
export function accountsWith(earlier: string[], current: string): string[] {
  return [...new Set([...earlier, current])];
}
