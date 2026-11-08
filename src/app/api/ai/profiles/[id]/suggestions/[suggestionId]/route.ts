import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { canManageProfile } from "@/lib/ai/profiles";
import { maybePushBrandVoice } from "@/lib/ai/ukb";

type Ctx = { params: Promise<{ id: string; suggestionId: string }> };

// Accept (new StyleGuideVersion, created_by: "edit-learning") or reject a
// continuous-learning suggestion. The guide is never mutated silently — this
// is the only path a suggestion turns into a real guide version.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const { id, suggestionId } = await params;
  const profile = await db.styleProfile.findUnique({ where: { id } });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageProfile(actor, profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const suggestion = await db.guideAmendmentSuggestion.findFirst({
    where: { id: suggestionId, profile_id: id },
  });
  if (!suggestion) {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }
  if (suggestion.status !== "pending") {
    return NextResponse.json(
      { error: `Suggestion already ${suggestion.status}` },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "accept" && body.action !== "reject") {
    return NextResponse.json(
      { error: "action must be accept or reject" },
      { status: 400 }
    );
  }

  if (body.action === "reject") {
    await db.guideAmendmentSuggestion.update({
      where: { id: suggestionId },
      data: { status: "rejected", resolved_at: new Date() },
    });
    return NextResponse.json({ data: { id: suggestionId, status: "rejected" } });
  }

  const latest = await db.styleGuideVersion.findFirst({
    where: { profile_id: id },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;

  await db.$transaction([
    db.styleGuideVersion.create({
      data: {
        profile_id: id,
        version,
        guide: suggestion.suggested_guide,
        created_by: "edit-learning",
      },
    }),
    db.guideAmendmentSuggestion.update({
      where: { id: suggestionId },
      data: { status: "accepted", resolved_at: new Date() },
    }),
    db.styleProfile.update({ where: { id }, data: {} }), // bump updated_at
  ]);
  await maybePushBrandVoice(profile, suggestion.suggested_guide);

  return NextResponse.json({ data: { id: suggestionId, status: "accepted", version } });
}
