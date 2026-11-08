import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

const VALID_STATUSES = ["pending", "published", "spam", "rejected"];

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermissionApi(request, "admin:access");
  if (error) return error;

  const { id } = await params;
  const body = (await request.json()) as { status?: string };

  if (!body.status || !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Comment inherits its org from the parent Post; constrain the write to
  // comments whose post lives in the actor's org so it can't reach across
  // tenants (updateMany lets us AND the parent filter into the where).
  const updated = await db.comment.updateMany({
    where: { id, post: { organization_id: actor.organizationId ?? "" } },
    data: { status: body.status },
  });
  if (updated.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ id, status: body.status });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermissionApi(req, "admin:access");
  if (error) return error;

  const { id } = await params;
  await db.comment.deleteMany({
    where: { id, post: { organization_id: actor.organizationId ?? "" } },
  });
  return NextResponse.json({ success: true });
}
