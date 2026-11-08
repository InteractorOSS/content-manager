import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";

export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const campaigns = await db.socialCampaign.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { posts: true } } },
  });
  return NextResponse.json({
    data: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      description: c.description,
      recycle: c.recycle,
      post_count: c._count.posts,
    })),
  });
}

export async function POST(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const body = (await req.json()) as {
    name?: string;
    color?: string;
    description?: string;
    recycle?: boolean;
  };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 422 });
  }
  const campaign = await db.socialCampaign.create({
    data: {
      name: body.name.trim(),
      color: body.color || null,
      description: body.description || null,
      recycle: !!body.recycle,
    },
  });
  return NextResponse.json({ data: campaign }, { status: 201 });
}
