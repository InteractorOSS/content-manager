/**
 * IndexNow (G#34, SEO-AEO-GEO-PLAN.md Layer D) — pinging Bing's IndexNow API
 * on publish/unpublish/delete/substantive-update/slug-change, per the plan's
 * research summary ("Bing calls it critical for AI-search freshness; ChatGPT
 * search partly leans on Bing"). Fire-and-forget by design: every function
 * here swallows its own errors and logs the result — a workflow action
 * (publish, delete, …) must never be slowed down or failed by IndexNow being
 * unreachable, per the plan's own instruction.
 *
 * The verification key itself (`Site.indexnow_key`) is generated and stored
 * here, and exposed to the outside world only through the public API
 * (`GET /api/public/indexnow-key`) — IndexNow requires the CONSUMING site to
 * host `${key}.txt` at its own domain root before a ping naming that key is
 * trusted, and this CMS has no way to serve a file on a domain it doesn't
 * own.
 */

import { randomBytes } from "node:crypto";
import type { prisma } from "@/lib/db";
import type { TenantDb } from "@/lib/tenant-db";

type PublicPrismaClient = typeof prisma;

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** A fresh IndexNow key: 32 hex characters, well within the protocol's 8–128 char bound. */
export function generateIndexNowKey(): string {
  return randomBytes(16).toString("hex");
}

export interface IndexNowSite {
  /** Base URL, no trailing slash. */
  url: string;
  indexnow_key: string | null;
}

export function buildIndexNowPingUrl(targetUrl: string, key: string): string {
  return `${INDEXNOW_ENDPOINT}?url=${encodeURIComponent(targetUrl)}&key=${encodeURIComponent(key)}`;
}

export interface IndexNowPingResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** One ping, one URL. Never throws — network failure is a normal, expected outcome here. */
export async function pingIndexNow(targetUrl: string, key: string): Promise<IndexNowPingResult> {
  try {
    const res = await fetch(buildIndexNowPingUrl(targetUrl, key), { method: "GET" });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fire-and-forget notification for one or more URLs on one site — logs the
 * result but never awaits it back to the caller, and never throws. A site
 * with no `indexnow_key` set is silently skipped (nothing to authenticate
 * the ping with), not an error: most orgs will never look at Settings →
 * Sites to notice this exists, and that must not make every publish/delete
 * noisy.
 */
export function notifyIndexNow(site: IndexNowSite, urls: string[]): void {
  if (!site.indexnow_key || urls.length === 0) return;
  const key = site.indexnow_key;
  for (const url of urls) {
    void pingIndexNow(url, key).then((result) => {
      if (result.ok) {
        console.log(`IndexNow: notified ${url} (status ${result.status})`);
      } else {
        console.error(`IndexNow: failed to notify ${url}`, result.error ?? `status ${result.status}`);
      }
    });
  }
}

/**
 * Resolve the `Site` rows a post's IndexNow ping should reach — one per
 * platform slug the post targets that has a registered `Site` row. `db` is
 * expected to be a tenant-scoped client (see tenant-db.ts) so this needs no
 * `organization_id` in its own `where` — every call site here already reads
 * through the actor's own `db`, the same one every CMS route uses.
 */
export async function resolveIndexNowSites(db: TenantDb, platforms: string[]): Promise<IndexNowSite[]> {
  if (platforms.length === 0) return [];
  const sites = await db.site.findMany({
    where: { slug: { in: platforms } },
    select: { url: true, indexnow_key: true },
  });
  return sites.map((s) => ({ url: s.url.replace(/\/+$/, ""), indexnow_key: s.indexnow_key }));
}

/**
 * The IndexNow key for one registered site, generating and persisting one
 * on first read if the site predates this column or was registered before
 * anyone set one. This is the ONE path that ever mints a key lazily — every
 * other reader (`resolveIndexNowSites`, the CMS's own site-settings routes)
 * just reads whatever is already there — because `GET /api/public/indexnow-key`
 * is the only place with no actor/org session to run a backfill from
 * anywhere else, and it's also the one place a consuming site's own
 * `/<key>.txt` route can ever learn its key from at all.
 */
export async function getOrCreateSiteIndexNowKey(
  db: PublicPrismaClient,
  site: { id: string; indexnow_key: string | null }
): Promise<string> {
  if (site.indexnow_key) return site.indexnow_key;
  const key = generateIndexNowKey();
  // Conditional on `indexnow_key` still being null at write time, not a bare
  // update: two near-simultaneous first-reads of the same never-keyed site
  // would otherwise each generate a DIFFERENT key and each write, with the
  // second write silently winning — the first caller's response (already
  // told to a consuming site to host at `/<key>.txt`) would then never match
  // the DB again, breaking verification for that site until someone notices
  // and manually fixes it. Losing this race means someone else's write
  // already landed — re-read and hand back THEIR key instead of minting a
  // second one nobody will ever host.
  const result = await db.site.updateMany({
    where: { id: site.id, indexnow_key: null },
    data: { indexnow_key: key },
  });
  if (result.count === 0) {
    const current = await db.site.findUnique({ where: { id: site.id }, select: { indexnow_key: true } });
    if (current?.indexnow_key) return current.indexnow_key;
  }
  return key;
}

/**
 * Fire-and-forget IndexNow ping for a post event across every site it
 * targets — publish, unpublish, delete, substantive update, or slug change
 * (SEO-AEO-GEO-PLAN.md Layer D). `slugs` lets a slug-change ping BOTH the old
 * URL (so the engine re-crawls, finds a 404 or the new 301, and drops it) and
 * the new one, in the same call.
 *
 * Deliberately swallows every failure itself (a resolve-sites DB error, a
 * bad `db`, …) rather than letting any of it reach the caller — this is
 * ALWAYS called un-awaited (`void notifyIndexNowForPost(...)`) from a
 * publish/unpublish/delete/update route, and none of those may be slowed
 * down, let alone failed, by a problem here.
 */
export async function notifyIndexNowForPost(
  db: TenantDb,
  post: { platforms: string[] },
  slugs: string[]
): Promise<void> {
  if (slugs.length === 0) return;
  try {
    const sites = await resolveIndexNowSites(db, post.platforms);
    for (const site of sites) {
      notifyIndexNow(site, slugs.map((slug) => `${site.url}/${slug}`));
    }
  } catch (e) {
    console.error("IndexNow: failed to resolve sites for ping", e);
  }
}
