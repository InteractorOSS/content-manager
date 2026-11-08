import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { canManageProfile } from "@/lib/ai/profiles";
import { maybePushBrandVoice } from "@/lib/ai/ukb";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const { id } = await params;
  const profile = await db.styleProfile.findUnique({
    where: { id },
    include: {
      samples: { orderBy: { inserted_at: "asc" } },
      guides: { orderBy: { version: "desc" } },
    },
  });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (profile.scope === "user" && profile.owner_id !== actor.user.id && !actor.permissions.has("admin:settings")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    data: {
      id: profile.id,
      name: profile.name,
      scope: profile.scope,
      owner_id: profile.owner_id,
      status: profile.status,
      can_manage: canManageProfile(actor, profile),
      samples: profile.samples.map((s) => ({
        id: s.id,
        source_type: s.source_type,
        source_ref: s.source_ref,
        title: s.title,
        text_preview: s.text.slice(0, 300),
        text_length: s.text.length,
        liked_notes: s.liked_notes,
        inserted_at: s.inserted_at.toISOString(),
      })),
      guides: profile.guides.map((g) => ({
        id: g.id,
        version: g.version,
        guide: g.guide,
        created_by: g.created_by,
        inserted_at: g.inserted_at.toISOString(),
      })),
    },
  });
}

// PATCH: rename, change status, or save a manual guide edit (new version).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const { id } = await params;
  const profile = await db.styleProfile.findUnique({ where: { id } });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageProfile(actor, profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    status?: string;
    guide?: string;
  };

  if (body.status && !["draft", "active", "archived"].includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  if (body.name !== undefined || body.status !== undefined) {
    await db.styleProfile.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: String(body.name).trim() }),
        ...(body.status !== undefined && { status: body.status }),
      },
    });
  }

  if (body.guide !== undefined) {
    const latest = await db.styleGuideVersion.findFirst({
      where: { profile_id: id },
      orderBy: { version: "desc" },
    });
    const guide = String(body.guide);
    await db.styleGuideVersion.create({
      data: {
        profile_id: id,
        version: (latest?.version ?? 0) + 1,
        guide,
        created_by: "manual",
      },
    });
    await db.styleProfile.update({ where: { id }, data: {} }); // bump updated_at
    await maybePushBrandVoice(profile, guide);
  }

  return NextResponse.json({ data: { id } });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const { id } = await params;
  const profile = await db.styleProfile.findUnique({ where: { id } });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageProfile(actor, profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.styleProfile.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
