import type { Post, Prisma } from "@prisma/client";
import type { TenantDb } from "@/lib/tenant-db";
import { authorDisplayName, type Actor } from "@/lib/rbac";

// The post trash. Deleting a post snapshots its row into DeletedPost and then
// deletes the post for real, so:
//   - no read path anywhere has to learn to skip deleted posts (a soft-delete
//     column would have to be filtered in some fifty queries, and a single
//     forgotten one republishes a deleted post on the public API);
//   - the slug is free again straight away;
//   - a deleted post can still be listed and restored for TRASH_RETENTION_DAYS.
// What is NOT kept: comments, approvals and revision history (they cascade
// with the post row). Social drafts survive on their own (their link is set
// null); the snapshot remembers which they were, and a restore relinks them.

export const TRASH_RETENTION_DAYS = 30;
const RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Where a snapshot keeps the ids of the post's social drafts. */
const SOCIAL_KEY = "__social_post_ids";

const DATE_FIELDS = ["published_at", "approved_at", "ai_generated_at", "inserted_at", "updated_at"] as const;

/** Move posts to the trash: snapshot, then delete. Returns how many went. */
export async function trashPosts(db: TenantDb, posts: Post[], actor: Actor | null): Promise<number> {
  if (posts.length === 0) return 0;
  const social = await db.socialPost.findMany({
    where: { source_post_id: { in: posts.map((p) => p.id) } },
    select: { id: true, source_post_id: true },
  });
  await db.deletedPost.createMany({
    data: posts.map((post) => ({
      post_id: post.id,
      title: post.title,
      slug: post.slug,
      status: post.status,
      platforms: post.platforms,
      snapshot: JSON.parse(
        JSON.stringify({
          ...post,
          [SOCIAL_KEY]: social.filter((sp) => sp.source_post_id === post.id).map((sp) => sp.id),
        })
      ) as Prisma.InputJsonValue,
      deleted_by_id: actor?.user.id ?? null,
      deleted_by_name: actor ? authorDisplayName(actor.user) : null,
    })),
  });
  try {
    await db.post.deleteMany({ where: { id: { in: posts.map((p) => p.id) } } });
  } catch (e) {
    // The delete failed, so the posts are still there: don't leave a trash
    // entry that would restore a duplicate.
    await db.deletedPost.deleteMany({ where: { post_id: { in: posts.map((p) => p.id) } } }).catch(() => {});
    throw e;
  }
  return posts.length;
}

/** Drop trash entries past the retention window. Best-effort. */
export async function purgeExpiredTrash(db: TenantDb, now = Date.now()): Promise<void> {
  await db.deletedPost.deleteMany({ where: { deleted_at: { lt: new Date(now - RETENTION_MS) } } }).catch(() => {});
}

export function trashExpiresAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RETENTION_MS);
}

export type TrashEntry = {
  id: string;
  post_id: string;
  title: string;
  slug: string;
  status: string;
  platforms: string[];
  deleted_at: string;
  deleted_by: string | null;
  expires_at: string;
};

export function formatTrashEntry(row: {
  id: string;
  post_id: string;
  title: string;
  slug: string;
  status: string;
  platforms: string[];
  deleted_at: Date;
  deleted_by_name: string | null;
}): TrashEntry {
  return {
    id: row.id,
    post_id: row.post_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    platforms: row.platforms,
    deleted_at: row.deleted_at.toISOString(),
    deleted_by: row.deleted_by_name,
    expires_at: trashExpiresAt(row.deleted_at).toISOString(),
  };
}

/**
 * The post row to recreate from a snapshot. Always comes back as a draft (a
 * restore must not republish something without anyone deciding to), with the
 * slug suffixed when another post has taken it meanwhile, and references to
 * rows that no longer exist cleared rather than failing the insert.
 */
export async function restoreData(
  db: TenantDb,
  snapshot: Record<string, unknown>,
  actor: Actor
): Promise<Prisma.PostUncheckedCreateInput> {
  const s = { ...snapshot };
  for (const f of DATE_FIELDS) {
    if (typeof s[f] === "string") s[f] = new Date(s[f] as string);
  }

  const baseSlug = String(s.slug || "restored-post");
  let slug = baseSlug;
  for (let n = 1; await db.post.findFirst({ where: { slug }, select: { id: true } }); n++) {
    slug = `${baseSlug}-restored${n > 1 ? `-${n}` : ""}`;
  }
  const idTaken = s.id ? await db.post.findFirst({ where: { id: String(s.id) }, select: { id: true } }) : null;

  const exists = async (model: "category" | "user", id: unknown) => {
    if (typeof id !== "string") return null;
    if (model === "category") return (await db.category.findFirst({ where: { id }, select: { id: true } })) ? id : null;
    return (await db.user.findUnique({ where: { id }, select: { id: true } })) ? id : null;
  };

  return {
    ...(idTaken ? {} : { id: String(s.id) }),
    organization_id: actor.organizationId ?? "",
    title: String(s.title ?? ""),
    slug,
    content: (s.content as string | null) ?? null,
    content_html: (s.content_html as string | null) ?? null,
    content_hash: (s.content_hash as string | null) ?? null,
    excerpt: (s.excerpt as string | null) ?? null,
    status: "draft",
    workflow_status: "draft",
    type: String(s.type ?? "blog"),
    featured_image: (s.featured_image as string | null) ?? null,
    featured_image_alt: (s.featured_image_alt as string | null) ?? null,
    featured_image_metadata: (s.featured_image_metadata as Prisma.InputJsonValue | undefined) ?? undefined,
    meta_description: (s.meta_description as string | null) ?? null,
    meta_keywords: (s.meta_keywords as string | null) ?? null,
    author_name: (s.author_name as string | null) ?? null,
    author_id: await exists("user", s.author_id),
    updated_by_name: authorDisplayName(actor.user),
    updated_by_id: actor.user.id,
    published_at: (s.published_at as Date | null) ?? null,
    reading_time: (s.reading_time as number | null) ?? null,
    tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
    platforms: Array.isArray(s.platforms) ? (s.platforms as string[]) : ["website"],
    content_format: String(s.content_format ?? "markdown"),
    content_styles: (s.content_styles as string | null) ?? null,
    original_filename: (s.original_filename as string | null) ?? null,
    metadata: (s.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
    category_id: await exists("category", s.category_id),
    ...(s.inserted_at instanceof Date && { inserted_at: s.inserted_at }),
  };
}

/** Restore one trash entry. Returns the recreated post's id, slug and title. */
export async function restoreFromTrash(
  db: TenantDb,
  entryId: string,
  actor: Actor
): Promise<{ id: string; slug: string; title: string } | null> {
  const entry = await db.deletedPost.findFirst({ where: { id: entryId } });
  if (!entry) return null;
  const snapshot = entry.snapshot as Record<string, unknown>;
  const data = await restoreData(db, snapshot, actor);
  const post = await db.post.create({ data, select: { id: true, slug: true, title: true } });
  const socialIds = Array.isArray(snapshot[SOCIAL_KEY]) ? (snapshot[SOCIAL_KEY] as string[]) : [];
  if (socialIds.length) {
    // Only drafts nothing else has claimed since.
    await db.socialPost.updateMany({
      where: { id: { in: socialIds }, source_post_id: null },
      data: { source_post_id: post.id },
    });
  }
  await db.deletedPost.delete({ where: { id: entry.id } });
  return post;
}
