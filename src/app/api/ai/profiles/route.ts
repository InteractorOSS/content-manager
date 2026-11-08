import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";

// Style profiles: the user's own plus org-scope ones (visible to everyone
// who can create content; editable per canManageProfile).
export async function GET() {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const profiles = await db.styleProfile.findMany({
    where: {
      OR: [{ owner_id: actor.user.id }, { scope: "org" }],
    },
    include: {
      _count: {
        select: {
          samples: true,
          guides: true,
          suggestions: { where: { status: "pending" } },
        },
      },
    },
    orderBy: [{ scope: "desc" }, { updated_at: "desc" }],
  });

  return NextResponse.json({
    data: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      scope: p.scope,
      owner_id: p.owner_id,
      status: p.status,
      sample_count: p._count.samples,
      guide_count: p._count.guides,
      pending_suggestion_count: p._count.suggestions,
      updated_at: p.updated_at.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    scope?: string;
  };
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const scope = body.scope === "org" ? "org" : "user";
  if (scope === "org" && !actor.permissions.has("admin:settings")) {
    return NextResponse.json(
      { error: "Org-scope profiles require admin:settings" },
      { status: 403 }
    );
  }

  const profile = await db.styleProfile.create({
    data: {
      name,
      scope,
      owner_id: scope === "user" ? actor.user.id : null,
    },
  });

  return NextResponse.json(
    { data: { id: profile.id, name: profile.name, scope: profile.scope } },
    { status: 201 }
  );
}
