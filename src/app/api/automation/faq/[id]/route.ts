import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { isFaqCategory, isFaqAudience } from "@/lib/faq";

function formatFaq(faq: Record<string, unknown> & { last_verified: Date | null; inserted_at: Date; updated_at: Date }) {
  return {
    ...faq,
    last_verified: faq.last_verified?.toISOString() ?? null,
    inserted_at: faq.inserted_at.toISOString(),
    updated_at: faq.updated_at.toISOString(),
  };
}

type Ctx = { params: Promise<{ id: string }> };

/**
 * Intake/freshness automation update path (see POST /api/automation/faq for
 * why this is separate from the CMS route). Structurally refuses
 * status="published" — not "unless the caller lacks content:publish", but
 * unconditionally, so this endpoint can never be the thing that publishes a
 * FAQ no matter how its token is scoped.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const data = (await req.json()) as Record<string, unknown>;

  if (data.status === "published") {
    return NextResponse.json(
      { error: "This endpoint cannot publish a FAQ — publishing is a human action in the CMS UI." },
      { status: 403 }
    );
  }
  if (data.status !== undefined && data.status !== "draft" && data.status !== "review") {
    return NextResponse.json({ error: "status must be draft or review" }, { status: 400 });
  }
  if (data.category !== undefined && !isFaqCategory(data.category)) {
    return NextResponse.json({ error: "category must be one of the allowed values" }, { status: 400 });
  }
  if (data.audience !== undefined && !isFaqAudience(data.audience)) {
    return NextResponse.json({ error: "audience must be public or sales-only" }, { status: 400 });
  }

  const existing = await db.faq.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const faq = await db.faq.update({
    where: { id },
    data: {
      ...(data.question !== undefined && { question: String(data.question) }),
      ...(data.answer !== undefined && { answer: String(data.answer) }),
      ...(data.category !== undefined && { category: String(data.category) }),
      ...(data.audience !== undefined && { audience: String(data.audience) }),
      ...(data.status !== undefined && { status: String(data.status) }),
      ...(data.last_verified !== undefined && {
        last_verified: data.last_verified ? new Date(String(data.last_verified)) : null,
      }),
      ...(data.verify_every_days !== undefined && { verify_every_days: Number(data.verify_every_days) }),
      ...(Array.isArray(data.sources) && { sources: data.sources.map(String) }),
      ...(Array.isArray(data.related) && { related: data.related.map(String) }),
      ...(data.increment_asked_count === true && { asked_count: { increment: 1 } }),
    },
  });

  return NextResponse.json({ data: formatFaq(faq) });
}
