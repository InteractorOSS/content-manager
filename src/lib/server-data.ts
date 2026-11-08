// Server-only data access — import only from Server Components, never from client components.
import { prisma } from "@/lib/db";
import type { Post, Category, Media } from "@/types/cms";

 
function formatPost(p: any): Post {
  return {
    ...p,
    inserted_at: p.inserted_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
    published_at: p.published_at?.toISOString() ?? null,
  };
}

 
function formatCategory(c: any): Category {
  return {
    ...c,
    inserted_at: c.inserted_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
  };
}

 
function formatMedia(m: any): Media {
  return {
    ...m,
    inserted_at: m.inserted_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
  };
}

// Every function here takes the caller's organizationId and filters on it —
// these read the raw `prisma` client (Server Components can't hold the
// tenant-scoped `db` requirePermission() hands to route handlers), so the
// org filter has to be applied explicitly at each call site instead. A null
// organizationId (no membership) short-circuits to an empty result: these
// are NOT NULL columns, so Prisma's generated filter types correctly refuse
// `organization_id: null` at compile time — there's no real row it could
// ever match anyway.

export async function serverListPosts(
  organizationId: string | null,
  params: {
    status?: string;
    type?: string;
    category_id?: string;
    published?: boolean;
    limit?: number;
  } = {}
): Promise<Post[]> {
  if (!organizationId) return [];

  const where: Record<string, unknown> = { organization_id: organizationId };
  if (params.status) where.status = params.status;
  if (params.type) where.type = params.type;
  if (params.category_id) where.category_id = params.category_id;
  if (params.published) where.status = "published";

  const posts = await prisma.post.findMany({
    where,
    include: { category: { select: { id: true, name: true, slug: true } } },
    orderBy: { updated_at: "desc" },
    ...(params.limit ? { take: params.limit } : {}),
  });
  return posts.map(formatPost);
}

export async function serverGetPostBySlug(
  slug: string,
  organizationId: string | null
): Promise<Post | null> {
  if (!organizationId) return null;

  const post = await prisma.post.findFirst({
    where: { slug, organization_id: organizationId },
    include: { category: { select: { id: true, name: true, slug: true } } },
  });
  return post ? formatPost(post) : null;
}

export async function serverListCategories(
  organizationId: string | null
): Promise<Category[]> {
  if (!organizationId) return [];

  const categories = await prisma.category.findMany({
    where: { organization_id: organizationId },
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
  });
  return categories.map(formatCategory);
}

export async function serverListMedia(
  organizationId: string | null
): Promise<Media[]> {
  if (!organizationId) return [];

  const media = await prisma.media.findMany({
    where: { organization_id: organizationId },
    orderBy: { inserted_at: "desc" },
  });
  return media.map(formatMedia);
}

export async function serverGetSubmissionCounts(organizationId: string | null) {
  if (!organizationId) {
    return { newContacts: 0, activeNewsletter: 0, pendingWaitlist: 0 };
  }

  const [newContacts, activeNewsletter, pendingWaitlist] = await Promise.all([
    prisma.contactSubmission.count({
      where: { organization_id: organizationId, status: "new" },
    }),
    prisma.newsletterSubscription.count({
      where: { organization_id: organizationId, status: "active" },
    }),
    prisma.waitlist.count({
      where: { organization_id: organizationId, status: "pending" },
    }),
  ]);
  return { newContacts, activeNewsletter, pendingWaitlist };
}
