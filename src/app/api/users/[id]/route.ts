import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { isOrgMember } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { actor, error } = await requirePermission("users:view");
  if (error) return error;

  const { id } = await params;
  if (!(await isOrgMember(actor.organizationId, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      roles: { include: { role: { select: { name: true, display_name: true } } } },
      _count: { select: { posts: true } },
    },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      bio: user.bio,
      avatar_url: user.avatar_url,
      roles: user.roles.map((r) => r.role.name),
      post_count: user._count.posts,
      last_login_at: user.last_login_at?.toISOString() ?? null,
      inserted_at: user.inserted_at.toISOString(),
    },
  });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { actor, error } = await requirePermission("users:edit");
  if (error) return error;

  const { id } = await params;
  if (!(await isOrgMember(actor.organizationId, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data = (await req.json()) as {
    name?: string;
    status?: string;
    bio?: string;
    avatar_url?: string;
  };

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (data.status && !["active", "inactive", "suspended"].includes(data.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name || null }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.bio !== undefined && { bio: data.bio || null }),
      ...(data.avatar_url !== undefined && { avatar_url: data.avatar_url || null }),
    },
  });

  return NextResponse.json({ data: { id: user.id, email: user.email, name: user.name, status: user.status } });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { actor, error } = await requirePermission("users:delete");
  if (error) return error;

  const { id } = await params;
  if (id === actor.user.id) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
  }
  if (!(await isOrgMember(actor.organizationId, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.user.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
