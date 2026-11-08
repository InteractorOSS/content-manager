import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import { pruneOldRevisions, revisionSnapshotData } from "@/lib/post-revisions";

type Ctx = { params: Promise<{ id: string }> };

function formatRevisionMeta(rev: {
  inserted_at: Date;
  edited_by: { id: string; name: string | null; email: string } | null;
  [key: string]: unknown;
}) {
  return {
    id: rev.id,
    title: rev.title,
    source: rev.source,
    label: rev.label ?? null,
    edited_by: rev.edited_by,
    inserted_at: rev.inserted_at.toISOString(),
  };
}

/**
 * Paginated revision list — metadata only (no content/content_html bodies),
 * newest first. GET /api/cms/posts/[id]/revisions/[revisionId] returns the
 * full snapshot for one revision.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  // Tenant-scoped: a post in another org resolves to null here, so this
  // 404s before ever touching post_revisions (see tenant-db.ts child-model note).
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const perPage = Math.min(100, parseInt(searchParams.get("per_page") ?? "50"));

  const [revisions, total] = await db.$transaction([
    db.postRevision.findMany({
      where: { post_id: id },
      select: {
        id: true,
        title: true,
        source: true,
        label: true,
        inserted_at: true,
        edited_by: { select: { id: true, name: true, email: true } },
      },
      orderBy: { inserted_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.postRevision.count({ where: { post_id: id } }),
  ]);

  return NextResponse.json({
    data: revisions.map(formatRevisionMeta),
    meta: { total, page, per_page: perPage },
  });
}

const CHECKPOINT_LABEL_MAX = 200;

/**
 * Save a labelled checkpoint of the post as it is now — "Before rewriting the
 * intro" — so a big change is one restore away. Labelled revisions are exempt
 * from age-based thinning. If the newest revision already holds exactly this
 * state, that one is labelled (when it has no label yet) and returned instead
 * of storing a duplicate. Same gate as editing the post.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;
  if (!canEditPost(actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "A label is required, e.g. \"Before rewriting the intro\"." }, { status: 400 });
  if (label.length > CHECKPOINT_LABEL_MAX) {
    return NextResponse.json({ error: `The label can be at most ${CHECKPOINT_LABEL_MAX} characters.` }, { status: 400 });
  }

  const select = {
    id: true,
    title: true,
    source: true,
    label: true,
    inserted_at: true,
    edited_by: { select: { id: true, name: true, email: true } },
  } as const;

  const latest = await db.postRevision.findFirst({
    where: { post_id: id },
    orderBy: { inserted_at: "desc" },
    select: { ...select, content: true, content_format: true, excerpt: true },
  });
  const sameState =
    latest &&
    latest.title === post.title &&
    latest.content === post.content &&
    latest.content_format === post.content_format &&
    latest.excerpt === post.excerpt;

  if (sameState) {
    const revision = latest.label
      ? latest
      : await db.postRevision.update({ where: { id: latest.id }, data: { label }, select });
    return NextResponse.json({ data: formatRevisionMeta(revision) });
  }

  const revision = await db.postRevision.create({
    data: { ...revisionSnapshotData(id, post, actor.user.id, "checkpoint"), label },
    select,
  });
  void pruneOldRevisions(db, id).catch(() => {});
  return NextResponse.json({ data: formatRevisionMeta(revision) }, { status: 201 });
}
