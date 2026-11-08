import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  const body = await request.json() as { status?: string };
  const data: Record<string, unknown> = { status: body.status };
  if (body.status === "unsubscribed") data.unsubscribedAt = new Date();

  const sub = await db.newsletterSubscription.update({ where: { id }, data });
  return NextResponse.json(sub);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  await db.newsletterSubscription.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
