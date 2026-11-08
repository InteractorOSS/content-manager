import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  const submission = await db.contactSubmission.findUnique({ where: { id } });
  if (!submission) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(submission);
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  const body = await request.json() as { status?: string };
  const submission = await db.contactSubmission.update({
    where: { id },
    data: { status: body.status },
  });

  return NextResponse.json(submission);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermission("admin:access");
  if (error) return error;

  const { id } = await params;
  await db.contactSubmission.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
