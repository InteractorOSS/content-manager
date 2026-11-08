import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { canManageProfile } from "@/lib/ai/profiles";
import { extractFromUrl, htmlToText } from "@/lib/ai/extract";

type Ctx = { params: Promise<{ id: string }> };

const MAX_SAMPLES = 12;

// Add a writing sample: from a URL, raw/uploaded text, or an existing post.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  const { id } = await params;
  const profile = await db.styleProfile.findUnique({
    where: { id },
    include: { _count: { select: { samples: true } } },
  });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageProfile(actor, profile)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (profile._count.samples >= MAX_SAMPLES) {
    return NextResponse.json(
      { error: `A profile holds at most ${MAX_SAMPLES} samples — remove one first` },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    source_type?: string;
    url?: string;
    text?: string;
    post_id?: string;
    title?: string;
    liked_notes?: string;
  };

  let title: string | null = body.title?.trim() || null;
  let text = "";
  let sourceRef: string | null = null;
  let sourceType = body.source_type ?? "";

  try {
    if (sourceType === "url" && body.url) {
      const extracted = await extractFromUrl(body.url);
      title = title ?? extracted.title;
      text = extracted.text;
      sourceRef = body.url;
    } else if (sourceType === "post" && body.post_id) {
      const post = await db.post.findUnique({ where: { id: body.post_id } });
      if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });
      title = title ?? post.title;
      text = htmlToText(post.content ?? "");
      sourceRef = post.id;
    } else if ((sourceType === "text" || sourceType === "upload") && body.text) {
      text = String(body.text).trim().slice(0, 60_000);
      sourceType = sourceType === "upload" ? "upload" : "text";
    } else {
      return NextResponse.json(
        { error: "Provide source_type=url|post|text|upload with url/post_id/text" },
        { status: 400 }
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Extraction failed" },
      { status: 422 }
    );
  }

  if (text.length < 200) {
    return NextResponse.json(
      { error: "Sample is too short to be useful (need at least ~200 characters)" },
      { status: 400 }
    );
  }

  const sample = await db.styleSample.create({
    data: {
      profile_id: id,
      source_type: sourceType,
      source_ref: sourceRef,
      title,
      text,
      liked_notes: body.liked_notes?.trim() || null,
    },
  });

  return NextResponse.json(
    {
      data: {
        id: sample.id,
        source_type: sample.source_type,
        title: sample.title,
        text_length: sample.text.length,
      },
    },
    { status: 201 }
  );
}
