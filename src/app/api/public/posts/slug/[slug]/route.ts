import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";
import { toPublicPost, resolvePostBySlugOrHistory } from "@/lib/public-post";
import { attachSeo } from "@/lib/post-seo";
import { buildPublicMarkdown } from "@/lib/post-markdown";

type Ctx = { params: Promise<{ slug: string }> };

export const OPTIONS = publicCorsPreflight;

/**
 * `GET .../slug/my-post.md` (G#34, Layer D) shares this dynamic route rather
 * than getting its own — Next.js dynamic segments can't be "half literal,
 * half param" (`[slug].md` as a folder name would match the URL segment
 * `[slug].md` literally, not `<anything>.md`), and the lookup logic this
 * needs (slug-or-history resolution, platform scoping) is identical to the
 * plain JSON route either way.
 */
const MARKDOWN_SUFFIX = ".md";

export const GET = withPublicCors(async function GET(req: NextRequest, { params }: Ctx) {
  const { slug: rawSlug } = await params;
  const wantsMarkdown = rawSlug.endsWith(MARKDOWN_SUFFIX);
  const slug = wantsMarkdown ? rawSlug.slice(0, -MARKDOWN_SUFFIX.length) : rawSlug;
  // Platform scoping: a consumer that passes ?platform= 404s posts not
  // targeted at it; no param keeps the pre-platforms behavior.
  const platform = req.nextUrl.searchParams.get("platform");

  const result = await resolvePostBySlugOrHistory(prisma, slug, platform);

  if (result.kind === "post") {
    const publicPost = await attachSeo(prisma, result.post, toPublicPost(result.post), platform);
    if (wantsMarkdown) {
      return new NextResponse(buildPublicMarkdown(publicPost), {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    return NextResponse.json({ data: publicPost });
  }
  // A slug this org has since retired (G#31): named separately from a live
  // post's own `redirect_to` (an author's free-text override) because this
  // one is derived, not authored — a caller that only understands the plain
  // post shape correctly treats an unrecognized `redirect_slug` key as
  // "not found" rather than mistaking it for a post with every other field
  // blank.
  if (result.kind === "redirect") {
    return NextResponse.json({ data: { redirect_slug: result.redirect_slug } });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
});
