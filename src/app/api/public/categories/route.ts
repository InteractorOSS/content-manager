import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";

export const OPTIONS = publicCorsPreflight;

// Public: categories with their published-post counts (for the website's
// category navigation/filtering).
export const GET = withPublicCors(async function GET() {
  const categories = await prisma.category.findMany({
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
    include: {
      _count: {
        select: {
          posts: {
            where: {
              status: "published",
              OR: [{ published_at: null }, { published_at: { lte: new Date() } }],
            },
          },
        },
      },
    },
  });

  return NextResponse.json({
    data: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      color: c.color,
      sort_order: c.sort_order,
      post_count: c._count.posts,
    })),
  });
});
