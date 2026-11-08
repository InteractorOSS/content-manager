import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { mergeContentTypes, titleCaseSlug } from "@/lib/content-types";
import { contentTypeSchema } from "@/lib/post-frontmatter";
import type { ContentType } from "@/types/cms";

/**
 * The org's content-type registry (G#19) — what the post editor offers in its
 * type control. `db` here is the tenant-scoped client from
 * requirePermissionApi, so both the read and the write are org-scoped without
 * this handler naming organization_id at all.
 *
 * The registry is for DISCOVERABILITY, not enforcement: `Post.type` is a plain
 * string with no FK to these rows, so an import carrying an unregistered type
 * still lands. That is why GET folds in types already in use.
 */
export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const [registered, inUse] = await Promise.all([
    db.contentType.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] }),
    db.post.findMany({ distinct: ["type"], select: { type: true } }),
  ]);

  const data = mergeContentTypes(
    registered.map(
      (t): ContentType => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        sort_order: t.sort_order,
      })
    ),
    inUse.map((p) => p.type)
  );
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const body = (await req.json()) as { content_type?: Record<string, unknown> };
  const data: Record<string, unknown> = body.content_type ?? body;

  const rawSlug = String(data.slug ?? "").trim();
  const parsed = contentTypeSchema.safeParse(rawSlug);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid content type slug" },
      { status: 400 }
    );
  }
  const slug = parsed.data;
  const name = String(data.name ?? "").trim() || titleCaseSlug(slug);

  try {
    const created = await db.contentType.create({
      data: {
        slug,
        name,
        description: data.description ? String(data.description) : null,
        sort_order: Number(data.sort_order ?? 100),
      },
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: `A content type named "${name}" (or slug "${slug}") already exists` },
        { status: 409 }
      );
    }
    throw e;
  }
}
