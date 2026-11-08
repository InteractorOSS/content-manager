import { NextRequest, NextResponse } from "next/server";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";
import { buildRssXml, loadFeedData } from "@/lib/feed";

/**
 * A site's RSS feed of its published posts — public, unauthenticated, same
 * `?platform=<slug>` convention as `/api/public/posts`. Unlike that route,
 * `platform` is required here: a feed needs exactly one site's base URL
 * (Site.url) to build `<link>` from, and there's no "all sites" feed to fall
 * back to.
 */
export const OPTIONS = publicCorsPreflight;

export const GET = withPublicCors(async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  if (!platform) {
    return NextResponse.json({ error: "?platform=<slug> is required" }, { status: 400 });
  }

  const feed = await loadFeedData(platform);
  if (!feed) {
    return NextResponse.json({ error: `No site registered for platform "${platform}"` }, { status: 404 });
  }

  return new NextResponse(buildRssXml(feed.site, feed.posts), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
});
