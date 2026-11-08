import { NextRequest, NextResponse } from "next/server";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";
import { buildLlmsTxt, loadLlmsData } from "@/lib/llms";

/**
 * A site's llms.txt (G#34, SEO-AEO-GEO-PLAN.md Layer D) — same `?platform=`
 * contract as `/api/public/rss.xml` and `/api/public/sitemap.xml`, required
 * for the same reason (one site's base URL per document, no "all sites"
 * fallback to build links under).
 */
export const OPTIONS = publicCorsPreflight;

export const GET = withPublicCors(async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  if (!platform) {
    return NextResponse.json({ error: "?platform=<slug> is required" }, { status: 400 });
  }

  const data = await loadLlmsData(platform);
  if (!data) {
    return NextResponse.json({ error: `No site registered for platform "${platform}"` }, { status: 404 });
  }

  return new NextResponse(buildLlmsTxt(data.site, data.posts), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});
