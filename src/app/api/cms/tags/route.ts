import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeBatchRefusal, siteScopeWhere } from "@/lib/token-site-scope";

export async function GET(req: NextRequest) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const q = req.nextUrl.searchParams.get("q") ?? "";

  // Collect all tags from posts and filter by query. A tag is nothing but the
  // posts carrying it, so a site-scoped token (G#21) sees the vocabulary of
  // the posts it can see — the same filter the post listing applies.
  const posts = await db.post.findMany({
    where: siteScopeWhere(apiToken),
    select: { tags: true },
  });
  const allTags = [...new Set(posts.flatMap((p) => p.tags))];
  const filtered = q
    ? allTags.filter((t) => t.toLowerCase().includes(q.toLowerCase()))
    : allTags;

  return NextResponse.json({ tags: filtered.sort() });
}

export async function DELETE(req: NextRequest) {
  // Removing a tag rewrites other authors' posts, so it needs edit_any.
  const { db, error, apiToken } = await requirePermissionApi(req, "content:edit_any");
  if (error) return error;

  const tag = req.nextUrl.searchParams.get("tag");
  if (!tag) return NextResponse.json({ error: "tag param required" }, { status: 400 });

  // Remove this tag from all posts
  const posts = await db.post.findMany({
    where: { tags: { has: tag } },
    select: { id: true, slug: true, tags: true, platforms: true },
  });

  // This is the one taxonomy write that edits posts, so it answers to the
  // token's site scope like any other post write: a product-manager token
  // must not strip a tag off the website's posts. Refused whole — dropping
  // the tag from only the in-scope posts would report success while leaving
  // the tag in place everywhere else.
  const outOfScope = siteScopeBatchRefusal(
    apiToken,
    posts,
    "The tag was left in place. Remove it in the CMS, or use a token that covers every site the tag appears on."
  );
  if (outOfScope) return outOfScope;

  await Promise.all(
    posts.map((p) =>
      db.post.update({
        where: { id: p.id },
        data: { tags: p.tags.filter((t) => t !== tag) },
      })
    )
  );

  return new NextResponse(null, { status: 204 });
}
