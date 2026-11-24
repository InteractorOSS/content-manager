import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { exportFilename } from "@/lib/post-frontmatter";
import { editFileVersion, etagOf, versionFromHeader } from "@/lib/post-edit-keys";
import { authorizeMirror, mirrorPostWhere } from "@/lib/mirror-session";

// The folder mirror's change list: every post of the mirror key's workspace
// as { id, filename, version, status }, one page at a time (ordered by id,
// ?cursor= the last id of the previous page). The first page also lists the
// ids of the workspace's posts in the trash, so the mirror can tell "moved
// to the trash" from "moved to another site".
//
// `version` is the same value /api/edit/file sends as its ETag (updated_at),
// so the mirror fetches a post's file only when its version moved. The page
// itself carries an ETag over its rows: a mirror polling an unchanged
// workspace gets a 304 and no body.

export const MIRROR_PAGE_MAX = 1000;

export async function GET(req: NextRequest) {
  const session = await authorizeMirror(req, "content:view");
  if (session.error) return session.error;
  const { auth } = session;

  const params = req.nextUrl.searchParams;
  const cursor = params.get("cursor") || null;
  const requested = Number(params.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MIRROR_PAGE_MAX) : MIRROR_PAGE_MAX;
  const where = { AND: mirrorPostWhere(auth.key) };

  const rows = await auth.db.post.findMany({
    where,
    select: { id: true, slug: true, status: true, updated_at: true },
    orderBy: { id: "asc" },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? page[page.length - 1].id : null;

  const trashed = cursor
    ? []
    : (
        await auth.db.deletedPost.findMany({
          where,
          select: { post_id: true },
          orderBy: { deleted_at: "desc" },
          take: 5000,
        })
      ).map((t) => t.post_id);

  const posts = page.map((p) => ({
    id: p.id,
    filename: exportFilename(p.slug),
    version: editFileVersion(p),
    status: p.status,
  }));

  const org = auth.actor.organizations.find((o) => o.id === auth.key.organization_id);
  const body = {
    data: {
      account: auth.actor.user.email,
      organization: org?.slug ?? "",
      site: auth.key.site,
      posts,
      trashed,
      next_cursor,
    },
  };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27);
  const headers = { etag: etagOf(version), "cache-control": "no-store" };
  if (versionFromHeader(req.headers.get("if-none-match")) === version) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(body, { headers });
}
