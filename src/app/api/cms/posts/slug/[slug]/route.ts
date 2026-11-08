import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import type { PermissionName } from "@/lib/rbac";
import { previewUrlForActor, omitPreviewToken } from "@/lib/preview-link";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const { searchParams } = req.nextUrl;
  const statusFilter = searchParams.get("status");

  // Published posts are readable by any signed-in user (proxy.ts already blocks
  // anonymous callers); anything else needs content:view. Either way resolve
  // the actor's org-scoped `db` so this lookup can't return another tenant's post.
  const perms: PermissionName[] =
    statusFilter !== "published" ? ["content:view"] : [];
  const { actor, db, error, apiToken } = await requirePermissionApi(req, ...perms);
  if (error) return error;

  const where: Record<string, unknown> = { slug };
  if (statusFilter) where.status = statusFilter;
  // Scheduling: the public published view excludes future-dated posts.
  if (statusFilter === "published") {
    where.OR = [{ published_at: null }, { published_at: { lte: new Date() } }];
  }

  const post = await db.post.findFirst({
    where,
    include: { category: { select: { id: true, name: true, slug: true } } },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;

  return NextResponse.json({
    data: {
      ...omitPreviewToken(post),
      inserted_at: post.inserted_at.toISOString(),
      updated_at: post.updated_at.toISOString(),
      published_at: post.published_at?.toISOString() ?? null,
      preview_url: previewUrlForActor(actor, post),
    },
  });
}
