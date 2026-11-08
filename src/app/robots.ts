import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/oauth/protocol";

/**
 * Only the public surfaces are crawlable: the front page (`/$` — the page
 * itself, not everything under it), the blog, the API docs, and the public
 * read API. Everything else is the signed-in CMS app, which also sets
 * `noindex` in its root layout.
 *
 * The AI *search* agents are named explicitly (not just covered by `*`) so the
 * policy is a visible decision: they are what let ChatGPT search, Claude and
 * Perplexity cite the blog (SEO-AEO-GEO-PLAN.md). OpenAI and Anthropic document
 * that their user-triggered fetchers may not apply robots.txt at all; they are
 * listed anyway so the intent is on record.
 */
export const PUBLIC_PATHS = ["/$", "/blog", "/docs", "/api/public/"];

export const AI_SEARCH_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
];

export default function robots(): MetadataRoute.Robots {
  const rule = { allow: PUBLIC_PATHS, disallow: "/" };
  return {
    rules: [
      { userAgent: "*", ...rule },
      ...AI_SEARCH_AGENTS.map((userAgent) => ({ userAgent, ...rule })),
    ],
    sitemap: `${publicOrigin()}/blog/sitemap.xml`,
  };
}
