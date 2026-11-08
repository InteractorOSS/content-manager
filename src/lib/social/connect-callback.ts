import { NextResponse, type NextRequest } from "next/server";
import { auth, oidcEnabled } from "@/lib/auth";
import { hasPermission, loadActor, type Actor } from "@/lib/rbac";
import { tenantDb, type TenantDb } from "@/lib/tenant-db";
import { safeCallbackPath } from "@/lib/sso-redirect";
import { getCredential, listCredentials } from "@/lib/interactor";
import { discoverChannelAccounts } from "@/lib/social/accounts";
import type { ChannelConnectReason } from "@/lib/social/connect-errors";

/**
 * Activation half of the hosted-OAuth connect flow: Interactor Core finishes
 * the provider handshake and redirects the BROWSER back here with the
 * credential it just stored. We bind that credential to the pending
 * `SocialChannel` row and send the reader on to `/social/channels`.
 *
 * Shared by two routes because the id can arrive two ways:
 *   - `/api/social/channels/callback/<channelId>?credential_id=...` — the shape
 *     we ask Core for now. The id is in the PATH, so Core can append its own
 *     query with whatever join character it likes and the URL still parses.
 *   - `/api/social/channels/callback?channel_id=...&credential_id=...` — the
 *     old shape. We asked Core to redirect to a URL that already had a query
 *     string on it, Core appended a second `?`, and the whole tail landed
 *     inside `channel_id`. Every flow started that way was unfinishable. The
 *     legacy route recovers both ids from that wreckage
 *     ({@link recoverJoinedCallbackParams}) and lands here too, so flows
 *     already in flight can still complete.
 *
 * Three rules this leg did not have before:
 *
 *   1. It is AUTHENTICATED. It used to take any browser's word for it and write
 *      through the raw `prisma` client with no org filter, so any signed-in
 *      member of any tenant could bind a credential onto another tenant's
 *      channel. The channel is now resolved through the tenant-scoped `db`, in
 *      the actor's own organizations only.
 *   2. It authorizes against the CHANNEL's organization, not the active one.
 *      A provider handshake takes long enough for someone to switch org in
 *      another tab, and coming back to "you don't have permission" for a
 *      channel you just created would be nonsense.
 *   3. The credential is VERIFIED before it is bound — same service, same Core
 *      identity. It used to be read only to copy a display name off, and
 *      whatever id was in the URL got written regardless.
 *
 * Every refusal leaves the row exactly as it was (status "pending") and
 * redirects with a `reason` code that `src/lib/social/connect-errors.ts` turns
 * into a sentence.
 */

/** Where the reader ends up, connected or not. */
export const CHANNELS_PAGE = "/social/channels";

/** Connecting a channel is the same permission that started the flow. */
const CONNECT_PERMISSION = "content:create" as const;

export interface CallbackIds {
  channelId: string | null;
  credentialId: string | null;
  /** Core's `?error=` on a connect the provider refused; absent on success. */
  providerError?: string | null;
}

/**
 * Pull the ids out of the legacy `?channel_id=` shape, including the broken one
 * where Core's own query got joined onto our value:
 *
 *   channel_id = "ch_123?credential_id=cred_9"   →  ch_123 + cred_9
 *   channel_id = "ch_123&credential_id=cred_9"   →  ch_123 + cred_9
 *
 * Next has already URL-decoded the value, so the tail is a plain query string.
 * A `credential_id` that arrived as its own param wins — it is the one Core
 * meant to send; the embedded copy is only a fallback.
 */
export function recoverJoinedCallbackParams(
  rawChannelId: string | null,
  credentialId: string | null
): CallbackIds {
  if (!rawChannelId) return { channelId: null, credentialId };

  const joinAt = rawChannelId.search(/[?&]/);
  if (joinAt === -1) return { channelId: rawChannelId, credentialId };

  const embedded = new URLSearchParams(rawChannelId.slice(joinAt + 1));
  return {
    channelId: rawChannelId.slice(0, joinAt) || null,
    credentialId: credentialId ?? embedded.get("credential_id"),
  };
}

type ChannelRow = {
  id: string;
  service_id: string;
  external_user_id: string;
  account_id: string | null;
  account_name: string | null;
};

type Located = { channel: ChannelRow; db: TenantDb; organizationId: string };

/**
 * Find the channel in one of the actor's own organizations, through the
 * tenant-scoped client each time. Deliberately NOT a raw `prisma` lookup
 * followed by a membership test: a channel outside the actor's orgs must be
 * indistinguishable from one that never existed, and the scoped client is what
 * guarantees that without the handler having to remember a `where`.
 *
 * The active org is tried first, so the ordinary case is one query.
 */
async function locateChannel(
  actor: Actor,
  channelId: string
): Promise<Located | null> {
  const orgIds = [
    ...(actor.organizationId ? [actor.organizationId] : []),
    ...actor.organizations
      .map((o) => o.id)
      .filter((id) => id !== actor.organizationId),
  ];

  for (const organizationId of orgIds) {
    const db = tenantDb(organizationId);
    const channel = (await db.socialChannel.findUnique({
      where: { id: channelId },
    })) as ChannelRow | null;
    if (channel) return { channel, db, organizationId };
  }
  return null;
}

type Verdict =
  | { ok: true; credential: Awaited<ReturnType<typeof getCredential>> }
  | { ok: false; reason: ChannelConnectReason };

/**
 * Gate, not enrichment: the credential Core names in the redirect must be for
 * this channel's service AND live under this channel's Core identity. Anything
 * we cannot positively confirm is a refusal — an unverifiable credential bound
 * to a channel is a channel that looks connected and fails at publish time.
 *
 * Core does not promise `external_user_id` on a credential body, so when it is
 * absent we ask the other way round: which credentials does this identity hold?
 * That is the same question, and `listCredentials` already exists to ask it.
 */
async function verifyCredential(
  channel: ChannelRow,
  credentialId: string
): Promise<Verdict> {
  let credential;
  try {
    credential = await getCredential(credentialId);
  } catch {
    return { ok: false, reason: "account_unverified" };
  }
  if (!credential) return { ok: false, reason: "account_unverified" };

  const service = credential.service_id ?? credential.service ?? null;
  if (!service) return { ok: false, reason: "account_unverified" };
  if (service !== channel.service_id) {
    return { ok: false, reason: "account_mismatch" };
  }

  const identity = credential.external_user_id ?? null;
  if (identity !== null) {
    if (identity !== channel.external_user_id) {
      return { ok: false, reason: "account_mismatch" };
    }
  } else {
    let owned;
    try {
      owned = await listCredentials(channel.external_user_id);
    } catch {
      return { ok: false, reason: "account_unverified" };
    }
    if (!owned.some((c) => c.id === credentialId)) {
      return { ok: false, reason: "account_mismatch" };
    }
  }

  return { ok: true, credential };
}

/**
 * Send a signed-out browser to sign in and come straight back here.
 *
 * This route is in the proxy's public allowlist for exactly one reason: the
 * generic gate answers an unauthenticated `/api/*` request with a bare JSON
 * 401, and this is a browser navigation at the end of a provider handshake —
 * landing on `{"error":"Unauthorized"}` is a dead end with the half-finished
 * channel still pending. `/oauth/authorize` sets the same precedent.
 */
function signInAndReturn(req: NextRequest): NextResponse {
  const back =
    safeCallbackPath(`${req.nextUrl.pathname}${req.nextUrl.search}`) ??
    CHANNELS_PAGE;
  const entry = oidcEnabled ? "/auth/sso" : "/login";
  return NextResponse.redirect(
    new URL(`${entry}?callbackUrl=${encodeURIComponent(back)}`, req.url)
  );
}

export async function handleChannelConnectCallback(
  req: NextRequest,
  ids: CallbackIds
): Promise<NextResponse> {
  const back = (query: string) =>
    NextResponse.redirect(new URL(`${CHANNELS_PAGE}?${query}`, req.url));
  const refuse = (reason: ChannelConnectReason) =>
    back(`connected=0&reason=${reason}`);

  const { channelId, credentialId } = ids;
  // Core sends the browser here with ?error= when the provider refused the
  // connect (the reader pressed Cancel, the app lacks a permission). That is
  // a different thing from Core losing the ids, and the reader should be told
  // which.
  if (ids.providerError) return refuse("provider_refused");
  if (!channelId || !credentialId) return refuse("missing_details");

  const session = await auth();
  if (!session?.user || session.error) return signInAndReturn(req);

  const actor = await loadActor(session.user);
  if (!actor) return signInAndReturn(req);

  const located = await locateChannel(actor, channelId);
  if (!located) return refuse("channel_not_found");

  // Permissions flatten from the membership role in ONE org, so an actor
  // resolved to a different active org holds the wrong set for this decision.
  // Re-resolve against the channel's org rather than re-deriving the flattening
  // here; `forceOrganizationId` is the existing seam for "the credential names
  // the org, not the browser".
  const scoped =
    located.organizationId === actor.organizationId
      ? actor
      : await loadActor(session.user, {
          forceOrganizationId: located.organizationId,
        });
  if (!scoped || scoped.organizationId !== located.organizationId) {
    return refuse("channel_not_found");
  }
  if (!hasPermission(scoped, CONNECT_PERMISSION)) {
    return refuse("no_permission");
  }

  const verdict = await verifyCredential(located.channel, credentialId);
  if (!verdict.ok) return refuse(verdict.reason);

  // Identity details off the credential are still best-effort — they only
  // decide what the card is labelled, never whether the channel activates.
  const credential = verdict.credential;
  const identity = (credential?.identity ?? credential?.metadata) as
    | Record<string, unknown>
    | undefined;
  const named =
    identity && (identity.name ?? identity.account_name ?? identity.username);
  let accountName =
    located.channel.account_name ??
    (typeof named === "string" ? named : null);

  // Fill the account id in when the credential can only mean one account (a
  // user with a single Facebook Page, a LinkedIn member who administers no
  // company page). With several, the channel activates without one and the
  // channels page opens its picker (`choose=`) — guessing would post to the
  // wrong Page. Best-effort like the name above: a provider that won't answer
  // must not undo a connect that succeeded, and the picker it opens retries.
  let accountId = located.channel.account_id;
  let choose = false;
  if (!accountId) {
    try {
      // Ask as the credential just verified — the row still carries the
      // previous one (or none) until the update below.
      const accounts = await discoverChannelAccounts({
        ...located.channel,
        credential_id: credentialId,
      });
      if (accounts?.length === 1) {
        accountId = accounts[0].id;
        accountName = located.channel.account_name ?? accounts[0].name;
      } else if (accounts) {
        choose = true;
      }
    } catch (err) {
      choose = true;
      console.warn(
        `[social-connect] could not list accounts for channel ${located.channel.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  await located.db.socialChannel.update({
    where: { id: located.channel.id },
    data: {
      credential_id: credentialId,
      status: "active",
      account_id: accountId,
      account_name: accountName,
      metadata: {
        credential_status: credential?.status ?? null,
        scopes: credential?.scopes ?? null,
      },
    },
  });

  // The other places this connection posts to share its credential, so a
  // reconnect has to bring them all back, not just the row that carried the
  // OAuth round trip.
  await located.db.socialChannel.updateMany({
    where: {
      external_user_id: located.channel.external_user_id,
      id: { not: located.channel.id },
    },
    data: { credential_id: credentialId, status: "active" },
  });

  return back(
    choose
      ? `connected=1&choose=${encodeURIComponent(located.channel.id)}`
      : "connected=1"
  );
}
