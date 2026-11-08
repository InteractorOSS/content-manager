import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";
import { getOrCreateSiteIndexNowKey } from "@/lib/indexnow";

/**
 * A site's IndexNow verification key (G#34, SEO-AEO-GEO-PLAN.md Layer D).
 * IndexNow requires the CONSUMING site to host this exact string at
 * `${site.url}/<key>.txt` before a ping naming that key is trusted — the CMS
 * cannot serve that file itself (it lives on the site's own domain), so this
 * is the one door the key comes out of, for whichever route on that site is
 * responsible for serving it back.
 */
export const OPTIONS = publicCorsPreflight;

export const GET = withPublicCors(async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  if (!platform) {
    return NextResponse.json({ error: "?platform=<slug> is required" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({
    where: { slug: platform },
    select: { id: true, indexnow_key: true },
  });
  if (!site) {
    return NextResponse.json({ error: `No site registered for platform "${platform}"` }, { status: 404 });
  }

  const key = await getOrCreateSiteIndexNowKey(prisma, site);
  return NextResponse.json({ data: { key } });
});
