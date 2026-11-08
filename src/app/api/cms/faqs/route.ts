import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import type { PermissionName } from "@/lib/rbac";
import { generateSlug } from "@/lib/utils";
import {
  isFaqCategory,
  isFaqAudience,
  isFaqStatus,
  DEFAULT_FAQ_AUDIENCE,
  DEFAULT_FAQ_STATUS,
  DEFAULT_VERIFY_EVERY_DAYS,
} from "@/lib/faq";

function formatFaq(faq: Record<string, unknown> & { last_verified: Date | null; inserted_at: Date; updated_at: Date }) {
  return {
    ...faq,
    last_verified: faq.last_verified?.toISOString() ?? null,
    inserted_at: faq.inserted_at.toISOString(),
    updated_at: faq.updated_at.toISOString(),
  };
}

// FAQ reuses the Post content type's permission set (content:view/create/...)
// rather than introducing a parallel faq:* set — this codebase already runs
// every Post.type (blog, ...) under one permission set, and no per-type
// precedent exists (see prisma/seed.mjs's PERMISSIONS/ROLE_PERMISSIONS).
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");

  const perms: PermissionName[] = status !== "published" ? ["content:view"] : [];
  const { db, error } = await requirePermissionApi(req, ...perms);
  if (error) return error;

  const category = searchParams.get("category");
  const audience = searchParams.get("audience");

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (category) where.category = category;
  if (audience) where.audience = audience;

  const faqs = await db.faq.findMany({
    where,
    orderBy: { updated_at: "desc" },
  });

  return NextResponse.json({ data: faqs.map(formatFaq) });
}

export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const body = (await req.json()) as { faq?: Record<string, unknown> };
  const data: Record<string, unknown> = body.faq ?? body;

  const question = String(data.question ?? "").trim();
  const answer = String(data.answer ?? "");
  if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });
  if (!answer) return NextResponse.json({ error: "answer is required" }, { status: 400 });

  const category = data.category;
  if (!isFaqCategory(category)) {
    return NextResponse.json({ error: `category must be one of the allowed values` }, { status: 400 });
  }

  const audience = data.audience !== undefined ? data.audience : DEFAULT_FAQ_AUDIENCE;
  if (!isFaqAudience(audience)) {
    return NextResponse.json({ error: "audience must be public or sales-only" }, { status: 400 });
  }

  // Publishing on create requires content:publish — mirrors POST /api/cms/posts.
  const canPublish = actor.permissions.has("content:publish");
  const requestedStatus = data.status !== undefined ? data.status : DEFAULT_FAQ_STATUS;
  if (!isFaqStatus(requestedStatus)) {
    return NextResponse.json({ error: "status must be draft, review, or published" }, { status: 400 });
  }
  const status = requestedStatus === "published" && !canPublish ? "draft" : requestedStatus;

  const slug = String(data.slug || generateSlug(question) || `faq-${Date.now()}`);

  let faq;
  try {
    faq = await db.faq.create({
      data: {
        slug,
        question,
        answer,
        category,
        audience,
        status,
        last_verified: data.last_verified ? new Date(String(data.last_verified)) : null,
        verify_every_days:
          data.verify_every_days !== undefined ? Number(data.verify_every_days) : DEFAULT_VERIFY_EVERY_DAYS,
        sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
        related: Array.isArray(data.related) ? data.related.map(String) : [],
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: `A FAQ with slug "${slug}" already exists` }, { status: 409 });
    }
    throw e;
  }

  const response: Record<string, unknown> = { data: formatFaq(faq) };
  if (requestedStatus === "published" && !canPublish) {
    response.warning = "You lack content:publish — the FAQ was saved as a draft.";
  }
  return NextResponse.json(response, { status: 201 });
}
