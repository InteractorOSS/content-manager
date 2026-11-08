import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { aiConfigured, AI_MODEL } from "@/lib/ai/client";
import { generateSeoAssist } from "@/lib/ai/generate";

// SEO generation (G#35, SEO-AEO-GEO-PLAN.md Layer E): an LLM pass drafts the
// readiness-check fields (src/lib/seo-readiness.ts) plus editorial
// suggestions, all of which the editor surfaces for a human to accept/edit —
// nothing here is ever written to the post by this route itself. When AI
// isn't configured (or the call fails), this falls back to the original
// heuristic (first-N-characters + top-N-words) so the editor's "Generate SEO
// Content" button never simply errors out.

const STOP_WORDS = new Set(
  `a an and are as at be but by for from has have how if in into is it its of on or
   that the their there these they this to was we what when where which who will with
   you your not can our all more one about over new use using than then so`.split(/\s+/)
);

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ")).trim();
}

function topKeywords(text: string, title: string, count: number): string[] {
  const frequency = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (raw.length < 4 || STOP_WORDS.has(raw)) continue;
    frequency.set(raw, (frequency.get(raw) ?? 0) + 1);
  }
  // Title words get a boost — they're what the post is about.
  for (const word of title.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) {
      frequency.set(word, (frequency.get(word) ?? 0) + 5);
    }
  }
  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}

function heuristicResult(title: string, text: string) {
  return {
    success: true as const,
    data: {
      meta_description: truncateAtWord(text, 155) || title,
      meta_keywords: topKeywords(text, title, 8).join(", "),
      excerpt: truncateAtWord(text, 250) || title,
      featured_image_alt: title,
      seo_title: null,
      answer_summary: null,
      question_headings: [] as string[],
      citations_needed: [] as string[],
      faq: [] as { question: string; answer: string }[],
      source: "heuristic" as const,
    },
  };
}

export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
  };
  const title = body.title ?? "";
  const content = body.content ?? "";
  const text = stripHtml(content);

  if (!text && !title) {
    return NextResponse.json(
      { error: "title or content is required" },
      { status: 400 }
    );
  }

  if (aiConfigured()) {
    // Tracked the same way as every other AI call site (src/app/api/ai/
    // generate/route.ts) so token spend on this button shows up in the same
    // cost/usage reporting — this is a real model call (max_tokens 4000,
    // adaptive thinking), not free.
    const job = await db.generationJob.create({
      data: {
        requested_by: actor.user.id,
        source_type: "text",
        formats: ["seo"],
        mode: "seo_assist",
        model: AI_MODEL,
      },
    });
    try {
      const { assist, usage } = await generateSeoAssist(title, content);
      await db.generationJob.update({
        where: { id: job.id },
        data: {
          status: "done",
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        },
      });
      return NextResponse.json({
        success: true,
        data: {
          meta_description: assist.meta_description,
          meta_keywords: assist.meta_keywords,
          excerpt: assist.excerpt,
          featured_image_alt: assist.featured_image_alt,
          seo_title: assist.seo_title,
          answer_summary: assist.answer_summary,
          question_headings: assist.question_headings,
          citations_needed: assist.citations_needed,
          faq: assist.faq,
          source: "llm",
        },
      });
    } catch (err) {
      // Degrade gracefully to the heuristic below rather than error out —
      // an LLM hiccup shouldn't block the editor's SEO button.
      await db.generationJob.update({
        where: { id: job.id },
        data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return NextResponse.json(heuristicResult(title, text));
}
