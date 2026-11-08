import { prisma } from "@/lib/db";
import { generateIndexNowKey } from "@/lib/indexnow";
import { slugify } from "@/lib/slug";

/**
 * Organization creation + settings helpers (SMM-CONSOLIDATION-PUNCHLIST T5/U1).
 *
 * Deliberately uses the RAW `prisma` client, not the tenant-scoped one from
 * `requirePermission()`. Creating an org is the one write that cannot be
 * org-scoped — there is no current org to scope it to yet, and for self-serve
 * signup (U1) the actor has no membership at all. This is exactly the
 * "explicitly-global code" carve-out named in CLAUDE.md; every org-scoped
 * write elsewhere must keep going through the tenant client.
 */

/** Membership roles allowed to rename an org or change its settings. */
export const ORG_SETTINGS_ROLES = ["owner", "admin"] as const;

export function canManageOrgSettings(role: string | null | undefined): boolean {
  return !!role && (ORG_SETTINGS_ROLES as readonly string[]).includes(role);
}

/** Kebab an org name into a slug candidate. Empty if the name has no alphanumerics. */
export function slugifyOrgName(name: string): string {
  return slugify(name, { maxLength: 48 });
}

/**
 * Find a free slug for `name`, appending -2, -3, … on collision.
 *
 * `Organization.slug` is globally unique (it is a tenant's public handle, not a
 * per-org value), so this races against concurrent creates by design: the
 * unique index is the real guard and the caller must still handle P2002. This
 * only keeps the common case from failing.
 */
export async function deriveUniqueOrgSlug(name: string): Promise<string> {
  const base = slugifyOrgName(name) || "org";
  const existing = await prisma.organization.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });
  const taken = new Set(existing.map((o) => o.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological only — 999 orgs sharing a base name.
  return `${base}-${Date.now()}`;
}

export interface CreatedOrganization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Create an organization and make `userId` its owner, atomically.
 *
 * The transaction is the point: an org with no membership is unreachable —
 * nobody can administer it, and it would not appear in any switcher — so a
 * half-applied create would leave an orphan row that only a DBA could clean up.
 */
export async function createOrganizationWithOwner(
  userId: string,
  name: string
): Promise<CreatedOrganization> {
  const slug = await deriveUniqueOrgSlug(name);

  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: name.trim(), slug },
      select: { id: true, name: true, slug: true },
    });
    await tx.membership.create({
      data: { user_id: userId, organization_id: org.id, role: "owner" },
    });
    // A generic, non-branded default distribution target — src/lib/sites.ts
    // deliberately has no cross-org built-in seeds (a shared "Interactor
    // Website" default implied an affiliation most orgs don't have), but a
    // brand-new org still needs ONE real, org-owned site to publish to:
    // DEFAULT_SITE_SLUGS names "website" as what a post targets when
    // unspecified, and the post editor always sends that as an explicit
    // selection, which the create/update routes validate against the org's
    // registered sites — with none, that validation would reject every new
    // post until someone finds Settings -> Sites first.
    //
    // `url` is required (it drives the site's RSS feed/sitemap links) but
    // there's no real domain to put here at signup time, so this is the same
    // obviously-fake placeholder as the historical backfill (migration
    // 20260912180000_add_site_url) — a path under a fake domain, not a
    // subdomain, so fixing it from Settings -> Sites never looks like it
    // needs new DNS.
    await tx.site.create({
      data: {
        organization_id: org.id,
        slug: "website",
        name: "Website",
        url: `https://example.com/${slug}`,
        sort_order: 0,
        // Same "working key from the moment a site exists" rationale as
        // `POST /api/cms/sites` (G#34) — the public indexnow-key endpoint
        // would lazily backfill one on its first read anyway, but this way
        // there's never a window where a legit publish's IndexNow ping
        // silently no-ops for lack of a key.
        indexnow_key: generateIndexNowKey(),
      },
    });
    // Land the creator in the org they just made, rather than leaving them on
    // whichever org happened to be active before.
    await tx.user.update({
      where: { id: userId },
      data: { current_organization_id: org.id },
    });
    return { ...org, role: "owner" };
  });
}
