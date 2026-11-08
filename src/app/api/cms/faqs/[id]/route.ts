import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { isFaqCategory, isFaqAudience, isFaqStatus } from "@/lib/faq";

function formatFaq(faq: Record<string, unknown> & { last_verified: Date | null; inserted_at: Date; updated_at: Date }) {
  return {
    ...faq,
    last_verified: faq.last_verified?.toISOString() ?? null,
    inserted_at: faq.inserted_at.toISOString(),
    updated_at: faq.updated_at.toISOString(),
  };
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const faq = await db.faq.findUnique({
    where: { id },
    include: { revisions: { orderBy: { inserted_at: "desc" } } },
  });
  if (!faq) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data: formatFaq(faq) });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { actor, db, error } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json()) as { faq?: Record<string, unknown> };
  const data: Record<string, unknown> = body.faq ?? body;

  const existing = await db.faq.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (data.category !== undefined && !isFaqCategory(data.category)) {
    return NextResponse.json({ error: "category must be one of the allowed values" }, { status: 400 });
  }
  if (data.audience !== undefined && !isFaqAudience(data.audience)) {
    return NextResponse.json({ error: "audience must be public or sales-only" }, { status: 400 });
  }

  // Status transitions to/from published are gated on content:publish;
  // without it the status field is left untouched — mirrors PUT /api/cms/posts/[id].
  if (
    data.status !== undefined &&
    data.status !== existing.status &&
    (data.status === "published" || existing.status === "published") &&
    !actor.permissions.has("content:publish")
  ) {
    delete data.status;
  }
  if (data.status !== undefined && !isFaqStatus(data.status)) {
    return NextResponse.json({ error: "status must be draft, review, or published" }, { status: 400 });
  }

  const answerChanged = data.answer !== undefined && String(data.answer) !== existing.answer;

  const updateData = {
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
    ...(data.slug !== undefined && { slug: String(data.slug) }),
  };

  let faq;
  try {
    if (answerChanged) {
      // Snapshot the OUTGOING answer before it's overwritten — revision
      // history records past versions; the current version lives on the row.
      const [, updated] = await db.$transaction([
        db.faqRevision.create({ data: { faq_id: existing.id, answer: existing.answer, edited_by_id: actor.user.id } }),
        db.faq.update({ where: { id }, data: updateData }),
      ]);
      faq = updated;
    } else {
      faq = await db.faq.update({ where: { id }, data: updateData });
    }
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "A FAQ with this slug already exists" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ data: formatFaq(faq) });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:delete");
  if (error) return error;

  const { id } = await params;
  await db.faq.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
