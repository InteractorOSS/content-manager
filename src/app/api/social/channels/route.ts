import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { initiateOAuth, InteractorError } from "@/lib/interactor";
import { getAdapter } from "@/lib/social/capabilities";
import { channelExternalUserId } from "@/lib/social/channel-identity";
import { formatChannel } from "@/lib/social/format";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const channels = await db.socialChannel.findMany({
    orderBy: { inserted_at: "desc" },
    include: {
      connected_by: { select: { id: true, name: true, email: true } },
    },
  });
  return NextResponse.json({ data: channels.map(formatChannel) });
}

/**
 * Connect a channel. Two modes (G#27):
 *
 *  - automated (default): creates a pending channel row and starts
 *    Interactor's hosted OAuth flow. The response contains
 *    `authorization_url` — the browser redirects there, the user authorizes
 *    on the provider, and Interactor sends them back to
 *    /api/social/channels/callback with a credential_id.
 *  - manual (`delivery_mode: "manual"`): no API access exists for this
 *    channel at all (e.g. a personal Facebook profile — Meta's Graph API
 *    only supports posting to Pages, never on a person's behalf), so there
 *    is nothing to OAuth into and no SERVICE_ADAPTERS entry is required.
 *    The channel is created active immediately; its posts land in the
 *    awaiting_manual queue instead of an automated publish attempt. General
 *    on purpose — any service_id can be manual, not just Facebook.
 */
export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const body = (await req.json()) as {
    service_id?: string;
    service_name?: string;
    account_id?: string;
    account_name?: string;
    delivery_mode?: string;
    /** Sign in again for an existing connection whose credential stopped working. */
    reconnect_channel_id?: string;
  };

  if (body.reconnect_channel_id) {
    const existing = await db.socialChannel.findUnique({
      where: { id: body.reconnect_channel_id },
    });
    if (!existing || existing.delivery_mode === "manual") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const existingAdapter = getAdapter(existing.service_id);
    if (!existingAdapter) {
      return NextResponse.json(
        { error: `Unsupported service "${existing.service_id}"` },
        { status: 422 }
      );
    }
    try {
      // Same Core identity, so the new credential replaces the old one and
      // every place this connection posts to keeps its row and its history.
      const flow = await initiateOAuth({
        serviceId: existing.service_id,
        externalUserId: existing.external_user_id,
        scopes: existingAdapter.connectScopes,
        successRedirectUrl: `${env.NEXTAUTH_URL}/api/social/channels/callback/${existing.id}`,
        metadata: { channel_id: existing.id, app: "content-management" },
      });
      return NextResponse.json(
        {
          data: {
            channel: formatChannel(existing),
            authorization_url: flow.authorization_url,
            flow_id: flow.flow_id,
          },
        },
        { status: 201 }
      );
    } catch (err) {
      return NextResponse.json({ error: describeConnectStartFailure(err) }, { status: 502 });
    }
  }

  if (body.delivery_mode === "manual") {
    const serviceId = String(body.service_id ?? "").trim();
    if (!serviceId) {
      return NextResponse.json(
        { error: "service_id is required" },
        { status: 422 }
      );
    }
    const channel = await db.socialChannel.create({
      data: {
        service_id: serviceId,
        service_name: body.service_name?.trim() || serviceId,
        delivery_mode: "manual",
        external_user_id: actor.user.id,
        account_id: body.account_id || null,
        account_name: body.account_name || null,
        // No OAuth/credential to activate — a manual channel is ready to
        // target the moment it's created.
        status: "active",
        connected_by_id: actor.user.id,
      },
    });
    return NextResponse.json({ data: { channel: formatChannel(channel) } }, { status: 201 });
  }

  const serviceId = String(body.service_id ?? "");
  const adapter = getAdapter(serviceId);
  if (!adapter) {
    return NextResponse.json(
      { error: `Unsupported service "${serviceId}"` },
      { status: 422 }
    );
  }

  // The Core identity is derived from the channel's own id, so the row has to
  // exist before we can name it — hence create-then-stamp rather than one
  // create. See src/lib/social/channel-identity.ts for why it is per-channel
  // and why existing rows are left alone.
  let createdId: string | null = null;
  try {
    const created = await db.socialChannel.create({
      data: {
        service_id: adapter.serviceId,
        service_name: adapter.displayName,
        delivery_mode: "automated",
        external_user_id: "",
        account_id: body.account_id || null,
        account_name: body.account_name || null,
        status: "pending",
        connected_by_id: actor.user.id,
      },
    });
    createdId = created.id;

    const externalUserId = channelExternalUserId(created.id);
    const channel = await db.socialChannel.update({
      where: { id: created.id },
      data: { external_user_id: externalUserId },
    });

    const flow = await initiateOAuth({
      serviceId: adapter.serviceId,
      externalUserId,
      scopes: adapter.connectScopes,
      // The id goes in the PATH, never a query string: Core appends its own
      // `?credential_id=...` to whatever it is handed, which welded our query
      // onto its own and made every connect unfinishable. A path segment
      // survives that join whatever character Core uses. `metadata` keeps
      // carrying the id too, so the flow is identifiable from Core's side.
      successRedirectUrl: `${env.NEXTAUTH_URL}/api/social/channels/callback/${created.id}`,
      metadata: { channel_id: created.id, app: "content-management" },
    });
    return NextResponse.json(
      {
        data: {
          channel: formatChannel(channel),
          authorization_url: flow.authorization_url,
          flow_id: flow.flow_id,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    // Nothing was authorized, so an unreachable half-built row would only show
    // up as a channel stuck at "pending" that the reader never started.
    if (createdId) {
      await db.socialChannel.delete({ where: { id: createdId } }).catch(() => {});
    }
    const status = err instanceof InteractorError && err.status === 402 ? 402 : 502;
    return NextResponse.json({ error: describeConnectStartFailure(err) }, { status });
  }
}

/**
 * What to tell the person when the sign-in could not be started.
 *
 * The one case worth its own sentence is the CMS's OWN credentials being
 * refused: every network fails the same way, the reader can do nothing about
 * it, and "Failed to obtain Interactor app token (401)" tells them neither.
 * The raw cause goes to the process log for whoever runs the box.
 */
function describeConnectStartFailure(err: unknown): string {
  if (err instanceof InteractorError && /app token/i.test(err.message)) {
    console.error(`[social-connect] ${err.message}`);
    return "The CMS couldn't sign in to Interactor with its own credentials, so no network can be connected right now. Nothing was changed. Ask whoever runs the CMS to check INTERACTOR_API_CLIENT_ID and INTERACTOR_API_CLIENT_SECRET on the server.";
  }
  return err instanceof InteractorError ? err.message : "The sign-in could not be started.";
}
