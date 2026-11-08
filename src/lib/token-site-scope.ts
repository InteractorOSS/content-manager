import { NextResponse } from "next/server";

/**
 * Site scope of a personal access token (G#21) — the second axis a token is
 * confined to, beneath the one organization it names.
 *
 * `ApiToken.site_scopes` holds site slugs chosen at mint time. EMPTY means the
 * token reaches every site in its org (the pre-G#21 behaviour, and what a
 * browser session always gets). Non-empty means the token may only act on
 * content that targets those sites, with the rule depending on what it does:
 *
 *   read   — the post targets AT LEAST ONE scoped site. A post distributed to
 *            `website` and `product-manager` is product-manager content, so a
 *            product-manager integration may read it. This is also the only
 *            rule a list query can express: Prisma's `hasSome` has no
 *            "is a subset of" counterpart for a String[] column.
 *   change — every site the post CURRENTLY targets is in scope. Editing that
 *            same two-site post would change what the website shows, which is
 *            exactly what a product-manager-only token must not do.
 *   target — every site the post WILL target is in scope (create, or a write
 *            that sets `platforms`). Checked in addition to `change`, never
 *            instead of it, so a token can't pull another site's post into its
 *            own scope by retargeting it.
 *
 * A post targeting no site at all is outside every scope for all three.
 *
 * Refusals are 403s that name the token's scope and the offending sites. They
 * are deliberately not 404s: a scoped token is still a member of the org, the
 * post is not a secret from it, and "Not found" for a post the user can see in
 * the CMS is unexplainable — the same reason /api/me reports `site_scopes`.
 * Only list endpoints FILTER, as they already do for organization.
 *
 * Pure apart from the response helper, and deliberately not in guard.ts: route
 * tests mock "@/lib/guard" wholesale, which would silently stub these out.
 */

export type SiteScopeAction = "read" | "change" | "target";

type ScopedToken = { site_scopes: string[] } | null | undefined;

/** The scope a request is confined to — empty for a session or an unscoped token. */
export function siteScopeOf(token: ScopedToken): string[] {
  return token?.site_scopes ?? [];
}

export function siteScopeAllows(
  scope: string[],
  platforms: string[],
  action: SiteScopeAction
): boolean {
  if (scope.length === 0) return true;
  const inScope = (slug: string) => scope.includes(slug);
  if (action === "read") return platforms.some(inScope);
  return platforms.length > 0 && platforms.every(inScope);
}

function list(slugs: string[]): string {
  return slugs.join(", ");
}

/** Plain-language reason a scoped token can't do `action` to a post with these platforms. */
export function siteScopeRefusalMessage(
  scope: string[],
  platforms: string[],
  action: SiteScopeAction
): string {
  const limited = `This token is limited to the site${scope.length === 1 ? "" : "s"} ${list(scope)}`;
  const outside = platforms.filter((p) => !scope.includes(p));

  if (platforms.length === 0) {
    return `${limited}, and this post targets no site, so the token can't ${action === "read" ? "read" : "change"} it.`;
  }
  switch (action) {
    case "read":
      return `${limited}, and this post only targets ${list(platforms)}. Use a token that covers ${list(platforms)}, or open the post in the CMS.`;
    case "change":
      return `${limited}, and this post also targets ${list(outside)}, so the token can't change it. Use a token that covers ${list(outside)} too, or make the change in the CMS.`;
    case "target":
      return `${limited}, so it can't make a post target ${list(outside)}. Set platforms to sites within that scope, or use a token that covers ${list(outside)}.`;
  }
}

/**
 * The 403 for a request outside the token's site scope, or null when it is
 * allowed. `hint` is appended to the message for route-specific advice.
 */
export function siteScopeRefusal(
  token: ScopedToken,
  platforms: string[],
  action: SiteScopeAction,
  hint?: string
): NextResponse | null {
  const scope = siteScopeOf(token);
  if (siteScopeAllows(scope, platforms, action)) return null;
  const message = siteScopeRefusalMessage(scope, platforms, action);
  return NextResponse.json(
    {
      error: hint ? `${message} ${hint}` : message,
      token_site_scopes: scope,
      post_sites: platforms,
    },
    { status: 403 }
  );
}

/** `where` fragment confining a post listing to the token's sites; empty when unscoped. */
export function siteScopeWhere(token: ScopedToken): { platforms?: { hasSome: string[] } } {
  const scope = siteScopeOf(token);
  return scope.length > 0 ? { platforms: { hasSome: scope } } : {};
}

/**
 * Validate the `site_scopes` a mint request asked for against the slugs the
 * org has (registered + built-in, i.e. orgSiteSlugs). Absent or empty means
 * unscoped. An unknown slug refuses the whole request rather than being
 * dropped: minting a token narrower than asked — or, if every slug were
 * unknown, silently UNSCOPED — is the opposite of what the caller meant.
 */
export function parseTokenSiteScopes(
  input: unknown,
  allowedSlugs: string[]
): { scopes: string[]; error?: never } | { scopes?: never; error: string } {
  if (input === undefined || input === null) return { scopes: [] };
  if (!Array.isArray(input) || input.some((v) => typeof v !== "string")) {
    return { error: "site_scopes must be a list of site slugs" };
  }
  const scopes = [...new Set(input as string[])];
  const unknown = scopes.filter((slug) => !allowedSlugs.includes(slug));
  if (unknown.length > 0) {
    return {
      error: `This organization has no site ${list(unknown)}. Choose from: ${list(allowedSlugs)}.`,
    };
  }
  return { scopes };
}

/** How many posts a batch refusal names before it says "and N more". */
const NAMED_SLUG_LIMIT = 5;

/**
 * The 403 for a BULK operation that would touch posts outside the token's
 * scope, or null when every post it matched is in scope.
 *
 * A batch refuses whole rather than quietly acting on the in-scope subset: a
 * partial success looks exactly like a full one from the call site, so the
 * caller would go away believing posts changed that never did. `consequence`
 * says what did not happen and what to do instead, in that operation's own
 * words. Applies the `change` rule, since a bulk operation writes.
 *
 * The message names at most NAMED_SLUG_LIMIT posts — a tag can sit on
 * hundreds — while `out_of_scope_count` carries the real total.
 */
export function siteScopeBatchRefusal(
  token: ScopedToken,
  posts: { slug: string; platforms: string[] }[],
  consequence: string
): NextResponse | null {
  const scope = siteScopeOf(token);
  if (scope.length === 0) return null;

  const outside = posts.filter((p) => !siteScopeAllows(scope, p.platforms, "change"));
  if (outside.length === 0) return null;

  const slugs = outside.map((p) => p.slug);
  const rest = slugs.length - NAMED_SLUG_LIMIT;
  // The list is POST slugs, so it never follows the words "other sites" —
  // that reads as if the slug named a site.
  const offenders =
    slugs.length === 1
      ? `The post ${slugs[0]} targets a site outside that scope.`
      : `These posts target sites outside that scope: ${list(slugs.slice(0, NAMED_SLUG_LIMIT))}` +
        `${rest > 0 ? ` and ${rest} more` : ""}.`;
  return NextResponse.json(
    {
      error:
        `This token is limited to the site${scope.length === 1 ? "" : "s"} ${list(scope)}. ` +
        `${offenders} ${consequence}`,
      token_site_scopes: scope,
      out_of_scope_slugs: slugs.slice(0, NAMED_SLUG_LIMIT * 4),
      out_of_scope_count: slugs.length,
    },
    { status: 403 }
  );
}
