import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { checkDuplicateTitleInOrg, checkPostReadiness } from "@/lib/seo-readiness";
import { HUMANIZER_VERSION } from "@/lib/humanizer";
import { reviewWithHumanizer, reviewWarnings } from "@/lib/humanizer/review";

type Ctx = { params: Promise<{ id: string }> };

// Search & AI readiness (G#32): read-only, so content:view is enough — the
// publish/approve gate in workflow/route.ts is what actually blocks a
// transition on these errors. Existing published posts are never
// retro-blocked; this route just reports for whoever asks.
//
// Humanizer: the rule-based tells are part of checkPostReadiness; the model
// review (the patterns no regex can see) is added here as `humanizer_review`
// warnings. `?humanizer_review=false` skips the model call; `humanizer.reviewed`
// says whether it ran (false without an AI key, or when the call failed).
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(_req, "content:view");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = checkPostReadiness(post);
  const duplicate = await checkDuplicateTitleInOrg(db, post.id, post.title);
  if (duplicate) result.warnings.push(duplicate);

  const skipReview = _req.nextUrl.searchParams.get("humanizer_review") === "false";
  const review = skipReview ? null : await reviewWithHumanizer(post);
  result.warnings.push(...reviewWarnings(review));

  return NextResponse.json({
    data: { ...result, humanizer: { version: HUMANIZER_VERSION, reviewed: review !== null } },
  });
}
