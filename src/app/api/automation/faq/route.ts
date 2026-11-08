import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { generateSlug } from "@/lib/utils";
import { isFaqCategory, isFaqAudience, DEFAULT_FAQ_AUDIENCE, DEFAULT_VERIFY_EVERY_DAYS } from "@/lib/faq";

function formatFaq(faq: Record<string, unknown> & { last_verified: Date | null; inserted_at: Date; updated_at: Date }) {
  return {
    ...faq,
    last_verified: faq.last_verified?.toISOString() ?? null,
    inserted_at: faq.inserted_at.toISOString(),
    updated_at: faq.updated_at.toISOString(),
  };
}

/**
 * Intake/freshness automation entry point — a machine caller authenticated
 * with a personal access token (Authorization: Bearer cms_pat_..., see
 * src/lib/guard.ts's requirePermissionApi and /settings/tokens), not a human
 * in the CMS UI. Distinct from POST /api/cms/faqs on purpose: this route
 * NEVER writes status="published" no matter what the caller sends or which
 * permissions their token carries — that guarantee has to hold structurally,
 * not just because the token happens to lack content:publish. Publishing
 * stays a human action in the UI (PUT /api/cms/faqs/[id] via a session).
 */
export async function POST(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const data = (await req.json()) as Record<string, unknown>;

  const question = String(data.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

  const category = data.category;
  if (!isFaqCategory(category)) {
    return NextResponse.json({ error: "category must be one of the allowed values" }, { status: 400 });
  }

  const audience = data.audience !== undefined ? data.audience : DEFAULT_FAQ_AUDIENCE;
  if (!isFaqAudience(audience)) {
    return NextResponse.json({ error: "audience must be public or sales-only" }, { status: 400 });
  }

  const slug = String(data.slug || generateSlug(question) || `faq-${Date.now()}`);

  let faq;
  try {
    faq = await db.faq.create({
      data: {
        slug,
        question,
        answer: data.answer ? String(data.answer) : "TODO",
        category,
        audience,
        status: "draft",
        sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
        related: Array.isArray(data.related) ? data.related.map(String) : [],
        verify_every_days:
          data.verify_every_days !== undefined ? Number(data.verify_every_days) : DEFAULT_VERIFY_EVERY_DAYS,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: `A FAQ with slug "${slug}" already exists` }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ data: formatFaq(faq) }, { status: 201 });
}
