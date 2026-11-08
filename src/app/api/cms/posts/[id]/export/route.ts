import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { exportFilename, serializePostFile } from "@/lib/post-frontmatter";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({
    where: { id },
    include: { category: { select: { slug: true } } },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;

  const file = serializePostFile(post);
  return new NextResponse(file, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(post.slug)}"`,
    },
  });
}
