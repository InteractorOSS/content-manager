import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

// Revoke (not delete) — keeps the audit trail (last_used_at, etc.) around.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { actor, error } = await requirePermission();
  if (error) return error;

  const { id } = await params;
  const token = await prisma.apiToken.findUnique({ where: { id } });
  if (!token || token.user_id !== actor.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.apiToken.update({
    where: { id },
    data: { revoked_at: new Date() },
  });
  return new NextResponse(null, { status: 204 });
}
