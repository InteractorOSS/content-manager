import { NextResponse } from "next/server";
import { buildSitemapXml } from "@/lib/feed";
import { blogSitemapData, resolveBlogSite } from "@/lib/blog";

// Every published post on the blog (no item cap — a sitemap should be
// complete), excluding noindex posts and syndicated copies whose canonical
// points elsewhere (G#34, Layer D — see blogSitemapData). Referenced from
// /robots.txt.
// Per request: posts publish at any time, and a build-time render would freeze
// (or, with no database at build, 404) the feed.
export const dynamic = "force-dynamic";

export async function GET() {
  const site = await resolveBlogSite();
  if (!site) return new NextResponse("Not found", { status: 404 });
  const feed = await blogSitemapData(site);
  return new NextResponse(buildSitemapXml(feed.site, feed.posts), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
