import { NextRequest, NextResponse } from "next/server";
import { authorizeEdit } from "@/lib/edit-session";

// The choices the writer editor's Details panel offers: the organization's
// categories, its sites (narrowed to the session's site scope, plus any the
// post already targets), and tags already in use, for suggestions.
export async function GET(req: NextRequest) {
  const session = await authorizeEdit(req, "content:view");
  if (session.error) return session.error;
  const { db } = session.auth;
  const scope = session.auth.key.site_scopes;

  const [categories, siteRows, tagRows] = await Promise.all([
    db.category.findMany({ select: { name: true, slug: true }, orderBy: { name: "asc" } }),
    db.site.findMany({ select: { name: true, slug: true }, orderBy: { name: "asc" } }),
    db.post.findMany({ select: { tags: true }, orderBy: { updated_at: "desc" }, take: 500 }),
  ]);

  const sites = siteRows.filter((s) => scope.length === 0 || scope.includes(s.slug));
  for (const slug of session.post.platforms) {
    if (!sites.some((s) => s.slug === slug)) sites.push({ name: slug, slug });
  }

  const counts = new Map<string, number>();
  for (const row of tagRows) for (const t of row.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([t]) => t);

  return NextResponse.json(
    {
      data: {
        categories,
        sites,
        tags,
        can_upload: session.auth.actor.permissions.has("media:upload"),
        can_delete: session.auth.actor.permissions.has("content:delete"),
      },
    },
    { headers: { "cache-control": "no-store" } }
  );
}
