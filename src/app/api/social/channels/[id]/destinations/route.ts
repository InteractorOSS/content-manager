import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { discoverChannelAccounts } from "@/lib/social/accounts";
import { getAdapter } from "@/lib/social/capabilities";
import { formatChannel } from "@/lib/social/format";

type Ctx = { params: Promise<{ id: string }> };

const MAX_DESTINATIONS = 50;

/**
 * Set the places one connection posts to.
 *
 *   PUT { accounts: [{ id, name? }] }
 *
 * A connection (one OAuth sign-in) can post to several places — the Pages it
 * manages, the Slack channels of its workspace, any subreddit. Each place is
 * its own SocialChannel row sharing the connection's credential. This makes
 * the connection's rows match `accounts` exactly: rows for places no longer
 * listed are removed, new places get a row, and an empty list leaves the
 * connection itself in place with nowhere chosen.
 *
 * For a network that can list its own accounts, every id must be one the
 * connection really has; for one that can't (a subreddit is typed), the id is
 * taken as given and the network refuses a wrong one at publish time.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const channel = await db.socialChannel.findUnique({ where: { id } });
  if (!channel) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (channel.delivery_mode === "manual") {
    return NextResponse.json(
      { error: "A manual channel is one place by definition. Add another manual channel instead." },
      { status: 422 }
    );
  }
  if (channel.status !== "active") {
    return NextResponse.json(
      { error: "This connection isn't active, so nothing was changed. Reconnect it first." },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => null)) as { accounts?: unknown } | null;
  const requested = parseAccounts(body?.accounts, channel.service_id);
  if ("error" in requested) return NextResponse.json({ error: requested.error }, { status: 400 });

  // Check the ids against what the connection can actually reach.
  let accounts = requested.accounts;
  try {
    const available = await discoverChannelAccounts(channel);
    if (available) {
      const byId = new Map(available.map((a) => [a.id, a.name]));
      const unknown = accounts.filter((a) => !byId.has(a.id));
      if (unknown.length > 0) {
        return NextResponse.json(
          {
            error:
              "Some of those aren't available to this connection, so nothing was changed. Reconnect the channel and share them when the network asks.",
            unknown_accounts: unknown.map((a) => a.id),
          },
          { status: 422 }
        );
      }
      // The network's own name beats whatever the caller sent.
      accounts = accounts.map((a) => ({ id: a.id, name: byId.get(a.id) ?? a.name }));
    }
  } catch {
    return NextResponse.json(
      { error: "We couldn't check those with the network, so nothing was changed. Try again." },
      { status: 502 }
    );
  }

  const siblings = await db.socialChannel.findMany({
    where: { external_user_id: channel.external_user_id, service_id: channel.service_id },
    orderBy: { inserted_at: "asc" },
  });

  const wanted = new Map(accounts.map((a) => [a.id, a.name]));
  const kept = siblings.filter((s) => s.account_id && wanted.has(s.account_id));
  const spare = siblings.filter((s) => !kept.includes(s));
  const missing = accounts.filter((a) => !kept.some((s) => s.account_id === a.id));

  // Reuse rows that no longer point anywhere wanted before creating new ones,
  // so the connection's first row (and its targets) survives a change of Page.
  for (const account of missing) {
    const reuse = spare.shift();
    if (reuse) {
      await db.socialChannel.update({
        where: { id: reuse.id },
        data: { account_id: account.id, account_name: account.name },
      });
    } else {
      await db.socialChannel.create({
        data: {
          service_id: channel.service_id,
          service_name: channel.service_name,
          delivery_mode: channel.delivery_mode,
          credential_id: channel.credential_id,
          external_user_id: channel.external_user_id,
          account_id: account.id,
          account_name: account.name,
          status: channel.status,
          connected_by_id: channel.connected_by_id,
        },
      });
    }
  }

  // Whatever is still spare points somewhere no longer wanted. Keep one row
  // when nothing at all is wanted — it IS the connection — and clear where it
  // points; remove the rest.
  if (accounts.length === 0 && spare.length > 0) {
    const anchor = spare.shift()!;
    await db.socialChannel.update({
      where: { id: anchor.id },
      data: { account_id: null, account_name: null },
    });
  }
  if (spare.length > 0) {
    await db.socialChannel.deleteMany({ where: { id: { in: spare.map((s) => s.id) } } });
  }

  const rows = await db.socialChannel.findMany({
    where: { external_user_id: channel.external_user_id, service_id: channel.service_id },
    orderBy: { inserted_at: "asc" },
  });
  return NextResponse.json({ data: rows.map(formatChannel) });
}

function parseAccounts(
  input: unknown,
  serviceId: string
): { accounts: { id: string; name: string }[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "accounts must be a list of { id, name }" };
  if (input.length > MAX_DESTINATIONS) {
    return { error: `A connection can post to at most ${MAX_DESTINATIONS} places` };
  }
  const adapter = getAdapter(serviceId);
  const seen = new Set<string>();
  const accounts: { id: string; name: string }[] = [];
  for (const entry of input) {
    const raw = (entry ?? {}) as { id?: unknown; name?: unknown };
    if (typeof raw.id !== "string") return { error: "every account needs an id" };
    // A subreddit is typed by hand, usually with its prefix.
    const id = (serviceId === "reddit" ? raw.id.replace(/^\/?r\//i, "") : raw.id).trim();
    if (!id || id.length > 200) return { error: "every account needs an id" };
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 200) : id;
    accounts.push({ id, name: serviceId === "reddit" && name === id ? `r/${id}` : name });
  }
  if (accounts.length > 0 && adapter && !adapter.requiresAccountId) {
    return { error: `${adapter.displayName} posts as the connected account, so there is nothing to choose` };
  }
  return { accounts };
}
