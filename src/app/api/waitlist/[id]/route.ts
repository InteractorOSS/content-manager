import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  const body = await request.json() as { status?: string };
  const data: Record<string, unknown> = { status: body.status };
  if (body.status === "confirmed") data.confirmedAt = new Date();
  if (body.status === "invited") data.invitedAt = new Date();

  const entry = await db.waitlist.update({ where: { id }, data });
  return NextResponse.json(entry);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  await db.waitlist.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
