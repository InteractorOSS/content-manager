/**
 * `GET /api/public/llms.txt?platform=` (G#34, SEO-AEO-GEO-PLAN.md Layer D) —
 * a plain-text index of one site's published posts, in the llms.txt
 * convention (llmstxt.org): an H1 site name, then an H2 "Posts" section with
 * one Markdown link + one-line description per post. The plan is explicit
 * that this is "near-zero cost, near-zero evidence... publish as a
 * by-product, claim nothing" — this is deliberately the simplest thing that
 * could work, not a bet that any crawler treats it specially.
 */

import { prisma } from "@/lib/db";
import type { FeedSite } from "@/lib/feed";

/** Same batching rationale as `SITEMAP_BATCH_SIZE` (feed.ts) — an index of
 *  every published post shouldn't be one unbounded `findMany`. Exported so
 *  the pagination boundary is unit-testable without a second hard-coded 500. */
export const LLMS_BATCH_SIZE = 500;

export interface LlmsPost {
  slug: string;
  title: string;
  excerpt: string | null;
  meta_description: string | null;
}

/**
 * Every published post for one site, oldest filtering identical to the other
 * public feeds (published + scheduled-for-the-future excluded). Unlike the
 * sitemap, this does NOT exclude `noindex` posts or honor `canonical_url`:
 * neither is a search-engine indexing signal the way a sitemap entry is, and
 * `/api/public/posts`/`/api/public/rss.xml` don't filter on them either — an
 * org that wants a post out of an LLM's context entirely has no field for
 * that today, and inventing one is out of scope for what this endpoint is
 * (a by-product index, per the plan's own "claim nothing").
 */
export async function loadLlmsData(platform: string): Promise<{ site: FeedSite; posts: LlmsPost[] } | null> {
  const site = await prisma.site.findFirst({ where: { slug: platform } });
  if (!site) return null;

  const posts: LlmsPost[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.post.findMany({
      where: {
        status: "published",
        platforms: { has: platform },
        OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
      },
      select: { id: true, slug: true, title: true, excerpt: true, meta_description: true },
      orderBy: { id: "asc" },
      take: LLMS_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    posts.push(...batch);
    if (batch.length < LLMS_BATCH_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }

  return { site: { name: site.name, url: site.url.replace(/\/+$/, "") }, posts };
}

function postUrl(site: FeedSite, post: { slug: string }): string {
  return `${site.url}/${post.slug}`;
}

/** llms.txt is Markdown — no XML escaping, just keep a title's own `[`/`]` from breaking the link syntax around it. */
function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
}

export function buildLlmsTxt(site: FeedSite, posts: LlmsPost[]): string {
  const lines = [`# ${site.name}`, "", `> Posts index for ${site.name} (${site.url}).`, "", "## Posts", ""];
  for (const post of posts) {
    const description = (post.meta_description?.trim() || post.excerpt?.trim() || "").replace(/\s+/g, " ");
    const link = `[${escapeMarkdownLinkText(post.title)}](${postUrl(site, post)})`;
    lines.push(description ? `- ${link}: ${description}` : `- ${link}`);
  }
  return lines.join("\n") + "\n";
}
