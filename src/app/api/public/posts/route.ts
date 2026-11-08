import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";
import { toPublicPost, PUBLIC_CATEGORY_SELECT, PUBLIC_AUTHOR_SELECT } from "@/lib/public-post";
import { attachSeo, type SeoContextCache } from "@/lib/post-seo";

export const OPTIONS = publicCorsPreflight;

export const GET = withPublicCors(async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type");
  const categoryId = searchParams.get("category_id");
  const platform = searchParams.get("platform");
  const authorSlug = searchParams.get("author_slug");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const perPage = Math.min(100, parseInt(searchParams.get("per_page") ?? "50"));

  // Scheduling: future-dated posts stay hidden until published_at passes.
  const where: Record<string, unknown> = {
    status: "published",
    OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
  };
  if (type) where.type = type;
  if (categoryId) where.category_id = categoryId;
  // Platform scoping: no param keeps the pre-platforms behavior (all posts)
  // so existing consumers don't break before they opt in.
  if (platform) where.platforms = { has: platform };
  // An unknown/unset author_slug (no public author has claimed it) matches
  // nothing rather than erroring — same "empty list, not 404" contract as
  // every other filter here.
  if (authorSlug) where.author = { author_slug: authorSlug };

  const [posts, total] = await prisma.$transaction([
    prisma.post.findMany({
      where,
      include: { category: { select: PUBLIC_CATEGORY_SELECT }, author: { select: PUBLIC_AUTHOR_SELECT } },
      orderBy: { published_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.post.count({ where }),
  ]);

  const seoCache: SeoContextCache = new Map();
  const data = await Promise.all(
    posts.map((post) => attachSeo(prisma, post, toPublicPost(post), platform, seoCache))
  );

  return NextResponse.json({
    data,
    meta: { total, page, per_page: perPage },
  });
});
