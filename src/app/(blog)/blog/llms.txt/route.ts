import { NextResponse } from "next/server";
import { buildLlmsTxt } from "@/lib/llms";
import { blogLlmsData, resolveBlogSite } from "@/lib/blog";

/**
 * The blog's own llms.txt — the same convention `GET
 * /api/public/llms.txt?platform=` serves (G#34), wired to this host (G#36 /
 * Layer G) via `blogLlmsData` rather than that route's own org-agnostic
 * `loadLlmsData` (see the doc comment on `blogLlmsData`), same
 * `resolveBlogSite`-by-URL pattern as `rss.xml`/`sitemap.xml` above it.
 * Per request: posts publish at any time, and a build-time render would freeze
 * (or, with no database at build, 404) the index.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const site = await resolveBlogSite();
  if (!site) return new NextResponse("Not found", { status: 404 });
  const feed = await blogLlmsData(site);
  return new NextResponse(buildLlmsTxt(feed.site, feed.posts), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
