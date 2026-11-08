import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { InteractorError } from "@/lib/interactor";
import { discoverChannelAccounts } from "@/lib/social/accounts";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The accounts this channel's connection can publish to, for the edit
 * dialog's picker: the Pages a Facebook user manages, a Slack workspace's
 * channels, the LinkedIn member plus the organizations they administer, the
 * Instagram business accounts linked to the Pages the sign-in manages.
 *
 * `supported: false` is not an error — it is how a service whose account
 * cannot be listed (a subreddit is typed, not owned) tells the dialog to keep
 * its free-text field.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const channel = await db.socialChannel.findUnique({ where: { id } });
  if (!channel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Nothing to ask a provider with: a manual channel has no credential, and a
  // channel that never finished connecting (or lost its connection) would
  // only produce a provider error the reader cannot act on from here.
  if (channel.delivery_mode === "manual" || channel.status !== "active") {
    return NextResponse.json({ data: { supported: false, accounts: [] } });
  }

  try {
    const accounts = await discoverChannelAccounts(channel);
    return NextResponse.json({
      data: { supported: accounts !== null, accounts: accounts ?? [] },
    });
  } catch (err) {
    console.warn(
      `[social-accounts] could not list accounts for channel ${channel.id}:`,
      err instanceof Error ? err.message : err
    );
    const message =
      err instanceof InteractorError
        ? "We couldn't get the list of accounts from the network. Nothing was changed. Try again, or reconnect the channel if this keeps happening."
        : "We couldn't load the list of accounts. Nothing was changed. Try again.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
