import type { TenantDb } from "@/lib/tenant-db";
import { mergeSites } from "@/lib/sites";
import type { Site } from "@/types/cms";

/**
 * The sites a write in THIS org may target — the registered rows plus the
 * built-in seeds.
 *
 * Split out of src/lib/sites.ts because that module is imported by the post
 * editor, a client component: the pure helpers there must stay free of the
 * Prisma client this query needs.
 *
 * `alsoAllow` carries the slugs the post being updated ALREADY has. Without it
 * a plain re-save of a post that carries an unregistered slug — one imported
 * from a file, or left over from a site the org later removed — would see that
 * slug filtered out and silently narrow the post's distribution. It is scoped
 * to the one post on purpose: folding in every in-use slug org-wide would mean
 * scanning the whole posts table on every write, and would let any post's
 * stray slug leak into the allowlist for every other post.
 */
export async function orgSites(db: TenantDb, alsoAllow: string[] = []): Promise<Site[]> {
  const registered = await db.site.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      sort_order: true,
    },
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
  });
  return mergeSites(registered as Site[], alsoAllow);
}

/** Slugs of {@link orgSites} — what post writes and token site scopes validate against. */
export async function orgSiteSlugs(
  db: TenantDb,
  alsoAllow: string[] = []
): Promise<string[]> {
  return (await orgSites(db, alsoAllow)).map((s) => s.slug);
}
