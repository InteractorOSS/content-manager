import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json()) as {
    name?: string;
    color?: string | null;
    description?: string | null;
    recycle?: boolean;
  };
  const existing = await db.socialCampaign.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const campaign = await db.socialCampaign.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.color !== undefined ? { color: body.color || null } : {}),
      ...(body.description !== undefined
        ? { description: body.description || null }
        : {}),
      ...(body.recycle !== undefined ? { recycle: body.recycle } : {}),
    },
  });
  return NextResponse.json({ data: campaign });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:delete");
  if (error) return error;

  const { id } = await params;
  const existing = await db.socialCampaign.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await db.socialCampaign.delete({ where: { id } });
  return NextResponse.json({ data: { deleted: true } });
}
