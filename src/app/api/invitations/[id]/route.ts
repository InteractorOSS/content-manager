import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

// Resend (refresh expiry + last_sent_at) a pending invitation.
export async function POST(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("users:create");
  if (error) return error;

  const { id } = await params;
  const invitation = await db.invitation.findUnique({ where: { id } });
  if (!invitation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (invitation.status !== "pending") {
    return NextResponse.json({ error: `Cannot resend a ${invitation.status} invitation` }, { status: 409 });
  }

  const updated = await db.invitation.update({
    where: { id },
    data: {
      last_sent_at: new Date(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return NextResponse.json({
    data: {
      id: updated.id,
      last_sent_at: updated.last_sent_at?.toISOString() ?? null,
      expires_at: updated.expires_at.toISOString(),
    },
  });
}

// Revoke a pending invitation.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("users:create");
  if (error) return error;

  const { id } = await params;
  const invitation = await db.invitation.findUnique({ where: { id } });
  if (!invitation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.invitation.update({
    where: { id },
    data: { status: "revoked" },
  });
  return new NextResponse(null, { status: 204 });
}
