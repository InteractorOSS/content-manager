import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";

type Ctx = { params: Promise<{ id: string; revisionId: string }> };

function formatRevision(rev: {
  inserted_at: Date;
  edited_by: { id: string; name: string | null; email: string } | null;
  [key: string]: unknown;
}) {
  return { ...rev, inserted_at: rev.inserted_at.toISOString() };
}

/** Full revision snapshot, including content. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id, revisionId } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;

  // `post_id: id` (not just `id: revisionId`) is what stops a guessed revision
  // id from another org's post — post_revisions carries no organization_id of
  // its own, so this constraint IS the tenancy check (see tenant-db.ts).
  const revision = await db.postRevision.findFirst({
    where: { id: revisionId, post_id: id },
    include: { edited_by: { select: { id: true, name: true, email: true } } },
  });
  if (!revision) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ data: formatRevision(revision) });
}
