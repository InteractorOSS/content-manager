import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { canManageProfile } from "@/lib/ai/profiles";

type Ctx = { params: Promise<{ id: string }> };

// Continuous learning (Phase D): guide amendment suggestions queued for this
// profile — proposed automatically when an AI-generated post with this
// profile's provenance is approved/published with edits that reveal a
// durable style preference. Never applied automatically.
export async function GET(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const { id } = await params;
  const profile = await db.styleProfile.findUnique({ where: { id } });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageProfile(actor, profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = req.nextUrl.searchParams.get("status") ?? "pending";

  const suggestions = await db.guideAmendmentSuggestion.findMany({
    where: { profile_id: id, ...(status !== "all" && { status }) },
    include: { post: { select: { id: true, title: true, slug: true } } },
    orderBy: { inserted_at: "desc" },
  });

  return NextResponse.json({
    data: suggestions.map((s) => ({
      id: s.id,
      diff_summary: s.diff_summary,
      rationale: s.rationale,
      suggested_guide: s.suggested_guide,
      status: s.status,
      post: s.post,
      inserted_at: s.inserted_at.toISOString(),
      resolved_at: s.resolved_at?.toISOString() ?? null,
    })),
  });
}
