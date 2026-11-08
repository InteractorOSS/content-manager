import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { deleteCredential } from "@/lib/interactor";
import { formatChannel } from "@/lib/social/format";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json()) as {
    account_name?: string;
    account_id?: string;
    default_target?: boolean;
  };

  const channel = await db.socialChannel.findUnique({ where: { id } });
  if (!channel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await db.socialChannel.update({
    where: { id },
    data: {
      ...(body.account_name !== undefined
        ? { account_name: body.account_name || null }
        : {}),
      ...(body.account_id !== undefined
        ? { account_id: body.account_id || null }
        : {}),
      ...(typeof body.default_target === "boolean"
        ? { default_target: body.default_target }
        : {}),
    },
  });
  return NextResponse.json({ data: formatChannel(updated) });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:delete");
  if (error) return error;

  const { id } = await params;
  const channel = await db.socialChannel.findUnique({ where: { id } });
  if (!channel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // `?scope=connection` disconnects the whole sign-in: every place it posts
  // to, and the credential behind them. Without it only this one place is
  // removed, and the credential goes only when nothing else still uses it —
  // the rows of one connection share it.
  const wholeConnection = req.nextUrl.searchParams.get("scope") === "connection";
  const siblings = channel.credential_id
    ? await db.socialChannel.findMany({
        where: { credential_id: channel.credential_id, id: { not: id } },
        select: { id: true },
      })
    : [];

  if (channel.credential_id && (wholeConnection || siblings.length === 0)) {
    try {
      await deleteCredential(channel.credential_id);
    } catch {
      // Credential may already be gone on the Interactor side.
    }
  }
  const ids = wholeConnection ? [id, ...siblings.map((s) => s.id)] : [id];
  await db.socialChannel.deleteMany({ where: { id: { in: ids } } });
  return NextResponse.json({ data: { deleted: true, removed: ids.length } });
}
