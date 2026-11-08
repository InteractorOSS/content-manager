import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeWhere } from "@/lib/token-site-scope";
import { formatTrashEntry, purgeExpiredTrash, TRASH_RETENTION_DAYS } from "@/lib/post-trash";

// Deleted posts still in the trash (src/lib/post-trash.ts), newest first.
// ?search= narrows by title or slug. A site-scoped token sees only entries
// whose sites are in its scope, the same rule as listing live posts.
export async function GET(req: NextRequest) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  await purgeExpiredTrash(db);
  const search = req.nextUrl.searchParams.get("search")?.trim().slice(0, 200);
  const contains = search ? { contains: search, mode: "insensitive" as const } : null;
  const rows = await db.deletedPost.findMany({
    where: {
      ...siteScopeWhere(apiToken),
      ...(contains && { OR: [{ title: contains }, { slug: contains }] }),
    },
    orderBy: { deleted_at: "desc" },
    take: 100,
  });
  return NextResponse.json({ data: rows.map(formatTrashEntry), retention_days: TRASH_RETENTION_DAYS });
}
