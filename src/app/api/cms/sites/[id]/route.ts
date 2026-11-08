import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { siteSlugSchema, siteUrlSchema } from "@/lib/sites";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Rename or remove one of this org's sites (G#18). `db` is the tenant-scoped
 * client, so an id belonging to another org simply doesn't resolve — a 404,
 * never someone else's row.
 *
 * A virtual in-use entry (a slug some post already carries but nobody has
 * registered — id `in-use:<slug>`) has no row to address here, so it 404s
 * rather than being editable. Registering a row with the same slug is how an
 * org gives it a real name/description — see mergeSites().
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json()) as { site?: Record<string, unknown> };
  const data: Record<string, unknown> = body.site ?? body;

  const existing = await db.site.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let slug = existing.slug;
  if (data.slug !== undefined) {
    const parsed = siteSlugSchema.safeParse(String(data.slug).trim());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid site slug" },
        { status: 400 }
      );
    }
    slug = parsed.data;
  }

  const name = data.name !== undefined ? String(data.name).trim() : existing.name;
  if (!name) {
    return NextResponse.json({ error: "A site name is required." }, { status: 400 });
  }

  let url = existing.url;
  if (data.url !== undefined) {
    const parsedUrl = siteUrlSchema.safeParse(String(data.url));
    if (!parsedUrl.success) {
      return NextResponse.json(
        { error: parsedUrl.error.issues[0]?.message ?? "Invalid site URL" },
        { status: 400 }
      );
    }
    url = parsedUrl.data;
  }

  try {
    const site = await db.site.update({
      where: { id },
      data: {
        name,
        slug,
        url,
        ...(data.description !== undefined && {
          description: String(data.description) || null,
        }),
        ...(data.sort_order !== undefined && { sort_order: Number(data.sort_order) }),
        // Resolved seo block publisher identity (G#33) — both fall back
        // (site name, org logo) when unset, so clearing either is valid.
        ...(data.publisher_name !== undefined && {
          publisher_name: String(data.publisher_name).trim() || null,
        }),
        ...(data.logo_url !== undefined && { logo_url: String(data.logo_url).trim() || null }),
        // IndexNow key (G#34): an org that already registered a key with
        // Bing under a different value can bring it here; sending an empty
        // value clears it back to null, which `GET /api/public/indexnow-key`
        // then lazily regenerates on its next read rather than leaving the
        // site with no working key at all.
        ...(data.indexnow_key !== undefined && {
          // `String(null)` is the truthy 4-char string "null", not falsy —
          // an explicit `null` (the clear-it case this comment describes)
          // must short-circuit BEFORE the stringify, or clearing persists
          // the literal text "null" as a "real" key that getOrCreateSiteIndexNowKey
          // then never regenerates.
          indexnow_key: data.indexnow_key === null ? null : String(data.indexnow_key).trim() || null,
        }),
      },
    });
    return NextResponse.json({ data: site });
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

/**
 * Remove a site from the registry.
 *
 * Refuses while posts still target it. `Post.platforms` has no FK to this
 * table, so the delete would otherwise succeed silently and leave those posts
 * pointing at a slug the editor no longer offers — the registry would look
 * tidy while the posts kept publishing to a site nobody can see or edit. The
 * count is the honest thing to show instead.
 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "categories:manage");
  if (error) return error;

  const { id } = await params;
  const existing = await db.site.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const inUse = await db.post.count({ where: { platforms: { has: existing.slug } } });
  if (inUse > 0) {
    return NextResponse.json(
      {
        error: `${inUse} post${inUse === 1 ? "" : "s"} still target "${existing.name}". Retarget them before removing it.`,
      },
      { status: 409 }
    );
  }

  await db.site.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
