import { NextResponse } from "next/server";
import { buildRssXml, FEED_MAX_ITEMS } from "@/lib/feed";
import { blogFeedData, resolveBlogSite } from "@/lib/blog";

// The blog's RSS feed. Same builder as /api/public/rss.xml, but resolved from
// the blog's own site (by URL — see src/lib/blog.ts) instead of a bare slug.
// Per request: posts publish at any time, and a build-time render would freeze
// (or, with no database at build, 404) the feed.
export const dynamic = "force-dynamic";

export async function GET() {
  const site = await resolveBlogSite();
  if (!site) return new NextResponse("Not found", { status: 404 });
  const feed = await blogFeedData(site, FEED_MAX_ITEMS);
  return new NextResponse(buildRssXml(feed.site, feed.posts), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
