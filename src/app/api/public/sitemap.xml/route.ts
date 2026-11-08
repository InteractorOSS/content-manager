import { NextRequest, NextResponse } from "next/server";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";
import { buildSitemapXml, loadSitemapData } from "@/lib/feed";

/**
 * A site's sitemap of its published posts — public, unauthenticated, same
 * `?platform=<slug>` convention as `/api/public/posts`. `platform` is
 * required (see rss.xml's route for why: one site's base URL per feed).
 */
export const OPTIONS = publicCorsPreflight;

export const GET = withPublicCors(async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  if (!platform) {
    return NextResponse.json({ error: "?platform=<slug> is required" }, { status: 400 });
  }

  const feed = await loadSitemapData(platform);
  if (!feed) {
    return NextResponse.json({ error: `No site registered for platform "${platform}"` }, { status: 404 });
  }

  return new NextResponse(buildSitemapXml(feed.site, feed.posts), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
});
