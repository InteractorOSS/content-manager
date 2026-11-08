import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { mergeSites, siteSlugSchema, siteUrlSchema } from "@/lib/sites";
import { titleCaseSlug } from "@/lib/content-types";
import { generateIndexNowKey } from "@/lib/indexnow";
import type { Site } from "@/types/cms";

/**
 * The org's site registry (G#18) — what the post editor offers as distribution
 * targets. `db` is the tenant-scoped client from requirePermissionApi, so both
 * the read and the write are org-scoped without this handler naming
 * organization_id at all.
 *
 * Like the content-type registry this is for DISCOVERABILITY, not enforcement:
 * `Post.platforms` is a plain String[] with no FK to these rows, so a post
 * imported carrying an unregistered slug still lands. That is why GET folds in
 * the slugs already in use.
 */
export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const [registered, inUse] = await Promise.all([
    db.site.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] }),
    db.post.findMany({ select: { platforms: true } }),
  ]);

  const data = mergeSites(
    registered.map(
      (s): Site => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        url: s.url,
        sort_order: s.sort_order,
        indexnow_key: s.indexnow_key,
      })
    ),
    // platforms is an array column, so `distinct` can't do this for us.
    inUse.flatMap((p) => p.platforms)
  );
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const body = (await req.json()) as { site?: Record<string, unknown> };
  const data: Record<string, unknown> = body.site ?? body;

  const rawSlug = String(data.slug ?? "").trim();
  const parsed = siteSlugSchema.safeParse(rawSlug);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid site slug" },
      { status: 400 }
    );
  }
  const slug = parsed.data;
  const name = String(data.name ?? "").trim() || titleCaseSlug(slug);

  const parsedUrl = siteUrlSchema.safeParse(String(data.url ?? ""));
  if (!parsedUrl.success) {
    return NextResponse.json(
      { error: parsedUrl.error.issues[0]?.message ?? "Invalid site URL" },
      { status: 400 }
    );
  }

  try {
    const created = await db.site.create({
      data: {
        slug,
        name,
        description: data.description ? String(data.description) : null,
        url: parsedUrl.data,
        sort_order: Number(data.sort_order ?? 100),
        // A working IndexNow key from the moment a site exists (G#34) — the
        // public `GET /api/public/indexnow-key` endpoint would lazily
        // backfill one anyway on its first read, so this just means the org
        // never has a window where that endpoint 200s with an empty key.
        indexnow_key: generateIndexNowKey(),
      },
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: `A site named "${name}" (or slug "${slug}") already exists` },
        { status: 409 }
      );
    }
    throw e;
  }
}
