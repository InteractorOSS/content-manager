import { z } from "zod";
import { titleCaseSlug } from "@/lib/content-types";
import type { Site } from "@/types/cms";

/**
 * Distribution targets — the consuming sites that can surface a post (G#18).
 *
 * Replaces the closed `PLATFORMS` allowlist that used to live in
 * src/lib/platforms.ts. That constant could only ever name sites the Interactor
 * org used, so a second org had no way to declare one without a deploy.
 *
 * Deliberately mirrors src/lib/content-types.ts rather than inventing a second
 * registry shape: same virtual seeds, same merge-with-in-use behaviour, same
 * "discoverability, not enforcement" contract. `Post.platforms` remains a
 * `String[]` of slugs — a post targets SEVERAL sites at once, which is the
 * whole point of the field and what the public `?platform=` filter matches
 * with `{ has: slug }`.
 */
export const SITE_SLUG_MAX_LENGTH = 64;
export const siteSlugSchema = z
  .string()
  .min(1)
  .max(SITE_SLUG_MAX_LENGTH, `slug must be at most ${SITE_SLUG_MAX_LENGTH} characters`)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric words separated by '-'");

export const SITE_URL_MAX_LENGTH = 2048;
/** The site's base URL — required on every registered row (see Site.url in schema.prisma). */
export const siteUrlSchema = z
  .string()
  .trim()
  .min(1, "URL is required")
  .max(SITE_URL_MAX_LENGTH, `URL must be at most ${SITE_URL_MAX_LENGTH} characters`)
  .url("must be a valid URL, e.g. https://example.com");

/**
 * What a post targets when the caller says nothing. Every org starts with NO
 * registered sites (there is no cross-org built-in seed — a generic
 * "Interactor Website" / "Product Manager" default made no sense once any
 * org can self-serve sign up, and implied a false affiliation for orgs that
 * have nothing to do with Interactor). "website" survives purely as this
 * fallback slug, which the in-use fold below turns into a real, selectable,
 * org-owned entry the first time it's actually used — an org that wants a
 * differently-named or additional site registers it from Settings → Sites.
 */
export const DEFAULT_SITE_SLUGS: string[] = ["website"];

/**
 * Merge an org's registered sites with any slug already in USE that nobody
 * registered.
 *
 * The in-use fold is what makes a post's distribution safe to round-trip
 * without a registry entry: a post imported (or created via the
 * DEFAULT_SITE_SLUGS fallback) carrying `platforms: [intranet]` stays
 * selectable in the editor even though no such row exists, so re-saving it
 * cannot silently drop a target. A registered row wins over an in-use slug
 * of the same name (an org may register "website" with its own name and
 * description once it's ready to).
 */
export function mergeSites(registered: Site[], slugsInUse: string[] = []): Site[] {
  const bySlug = new Map<string, Site>();
  for (const slug of slugsInUse) {
    bySlug.set(slug, {
      id: `in-use:${slug}`,
      slug,
      name: titleCaseSlug(slug),
      description: null,
      url: null,
      sort_order: 900,
      indexnow_key: null,
    });
  }
  // Registered rows override, so this loop runs last.
  for (const s of registered) bySlug.set(s.slug, s);

  return [...bySlug.values()].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
  );
}

/**
 * Coerce client-supplied site slugs against the slugs this org actually has.
 *
 * Returns null when the field wasn't sent (caller keeps the existing value or
 * the default). Returns the deduped valid subset otherwise — an EMPTY result
 * means the client sent only unknown slugs, which callers must reject rather
 * than store: a post with no targets would silently vanish from every site.
 * That refusal is the one piece of enforcement here, and it is why the caller
 * passes the org's merged slugs rather than this module knowing them.
 */
export function parseSiteSlugs(input: unknown, allowedSlugs: Iterable<string>): string[] | null {
  if (!Array.isArray(input)) return null;
  const allowed = new Set(allowedSlugs);
  return [...new Set(input.filter((v): v is string => typeof v === "string" && allowed.has(v)))];
}
