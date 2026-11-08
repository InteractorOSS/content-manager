import { NextRequest, NextResponse } from "next/server";
import { browseKeyFromRequest } from "@/lib/post-browse-keys";
import { siteScopeWhere } from "@/lib/token-site-scope";
import { formatTrashEntry, purgeExpiredTrash } from "@/lib/post-trash";

// The writer's post list (/write/posts), authenticated by a browse key.
// Narrowed to the key's site and the minting token's site scope, optionally
// by ?search= (title, slug, excerpt, body), newest-updated first.
//
// ?view= picks a tab: all (default) | drafts | review | published | trash.
// Trash lists deleted posts (src/lib/post-trash.ts) rather than live ones.
// Every response carries `counts` per tab for the tab labels.

const VIEWS = ["all", "drafts", "review", "published", "trash"] as const;
type View = (typeof VIEWS)[number];

const VIEW_WHERE: Record<Exclude<View, "trash">, Record<string, unknown>> = {
  all: {},
  drafts: { status: { not: "published" }, workflow_status: { not: "pending_review" } },
  review: { status: { not: "published" }, workflow_status: "pending_review" },
  published: { status: "published" },
};

export async function GET(req: NextRequest) {
  const auth = await browseKeyFromRequest(req);
  if (!auth) {
    return NextResponse.json(
      { error: "This list has expired or its link is invalid. Ask Claude to show your posts again." },
      { status: 401 }
    );
  }
  if (!auth.actor.permissions.has("content:view")) {
    return NextResponse.json({ error: "Forbidden", missing_permissions: ["content:view"] }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const view = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "all";
  const search = params.get("search")?.trim().slice(0, 200);
  const contains = search ? { contains: search, mode: "insensitive" as const } : null;

  // What every tab shares: the key's site scope, its site, the search.
  const base: Record<string, unknown>[] = [siteScopeWhere({ site_scopes: auth.key.site_scopes })];
  if (auth.key.site) base.push({ platforms: { has: auth.key.site } });
  const postSearch = contains
    ? [{ OR: [{ title: contains }, { slug: contains }, { excerpt: contains }, { content: contains }] }]
    : [];
  const trashSearch = contains ? [{ OR: [{ title: contains }, { slug: contains }] }] : [];

  await purgeExpiredTrash(auth.db);
  const [all, drafts, review, published, trash] = await Promise.all([
    ...(["all", "drafts", "review", "published"] as const).map((v) =>
      auth.db.post.count({ where: { AND: [...base, ...postSearch, VIEW_WHERE[v]] } })
    ),
    auth.db.deletedPost.count({ where: { AND: [...base, ...trashSearch] } }),
  ]);
  const counts = { all, drafts, review, published, trash };

  const common = {
    account: auth.actor.user.email,
    organization: auth.actor.organizations.find((o) => o.id === auth.key.organization_id)?.name ?? "",
    site: auth.key.site,
    view,
    counts,
    can_restore: auth.actor.permissions.has("content:create"),
  };

  if (view === "trash") {
    const rows = await auth.db.deletedPost.findMany({
      where: { AND: [...base, ...trashSearch] },
      orderBy: { deleted_at: "desc" },
      take: 100,
    });
    return NextResponse.json(
      { data: { ...common, posts: [], trash: rows.map(formatTrashEntry) } },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const posts = await auth.db.post.findMany({
    where: { AND: [...base, ...postSearch, VIEW_WHERE[view]] },
    select: {
      id: true,
      title: true,
      excerpt: true,
      status: true,
      workflow_status: true,
      platforms: true,
      content_format: true,
      featured_image: true,
      updated_at: true,
    },
    orderBy: { updated_at: "desc" },
    take: 100,
  });

  return NextResponse.json(
    {
      data: {
        ...common,
        posts: posts.map((p) => ({ ...p, updated_at: p.updated_at.toISOString() })),
        trash: [],
      },
    },
    { headers: { "cache-control": "no-store" } }
  );
}
