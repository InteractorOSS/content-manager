import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { canManageProfile } from "@/lib/ai/profiles";
import { analyzeStyle } from "@/lib/ai/style";
import { aiConfigured, AI_MODEL } from "@/lib/ai/client";
import { maybePushBrandVoice } from "@/lib/ai/ukb";

type Ctx = { params: Promise<{ id: string }> };

// Run (or re-run) style analysis over the profile's samples and interview
// notes, producing a new StyleGuideVersion.
export async function POST(_req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  if (!aiConfigured()) {
    return NextResponse.json(
      { error: "AI is not configured — set ANTHROPIC_API_KEY on the server" },
      { status: 503 }
    );
  }

  const { id } = await params;
  const profile = await db.styleProfile.findUnique({
    where: { id },
    include: {
      samples: { orderBy: { inserted_at: "asc" } },
      guides: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageProfile(actor, profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (profile.samples.length === 0) {
    return NextResponse.json(
      { error: "Add at least one writing sample first" },
      { status: 400 }
    );
  }

  const job = await db.generationJob.create({
    data: {
      requested_by: actor.user.id,
      profile_id: id,
      source_type: "text",
      formats: ["style-guide"],
      mode: "create",
      model: AI_MODEL,
    },
  });

  try {
    const previousGuide = profile.guides[0]?.guide ?? null;
    const hasInterviewNotes = profile.samples.some((s) => s.liked_notes);

    const result = await analyzeStyle(
      profile.samples.map((s) => ({
        title: s.title,
        text: s.text,
        likedNotes: s.liked_notes,
      })),
      previousGuide
    );

    const version = (profile.guides[0]?.version ?? 0) + 1;
    const guideRow = await db.styleGuideVersion.create({
      data: {
        profile_id: id,
        version,
        guide: result.guide,
        created_by: hasInterviewNotes ? "interview" : "analysis",
      },
    });
    await db.$transaction([
      db.generationJob.update({
        where: { id: job.id },
        data: {
          status: "done",
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          outputs: { guide_version_id: guideRow.id, version },
        },
      }),
      db.styleProfile.update({
        where: { id },
        data: { status: profile.status === "draft" ? "active" : profile.status },
      }),
    ]);
    await maybePushBrandVoice(profile, result.guide);

    return NextResponse.json({
      data: {
        version,
        guide: result.guide,
        created_by: guideRow.created_by,
        usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Analysis failed";
    await db.generationJob.update({
      where: { id: job.id },
      data: { status: "failed", error: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
