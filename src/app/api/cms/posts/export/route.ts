import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeWhere } from "@/lib/token-site-scope";
import { exportFilename, serializePostFile } from "@/lib/post-frontmatter";

// Bulk export as an Obsidian-ready vault folder — content/posts/<slug>.md
// per post (see FILE-BASED-CONTENT-PLAN.md D3 on the org-aware path shape).
export async function GET(req: NextRequest) {
  const { db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const status = req.nextUrl.searchParams.get("status");
  const posts = await db.post.findMany({
    // A site-scoped token (G#21) exports only posts targeting its sites.
    where: { ...(status && { status }), ...siteScopeWhere(apiToken) },
    include: { category: { select: { slug: true } } },
    orderBy: { updated_at: "desc" },
  });

  const zip = new JSZip();
  const folder = zip.folder("content/posts")!;
  for (const post of posts) {
    folder.file(exportFilename(post.slug), serializePostFile(post));
  }

  const archive = await zip.generateAsync({ type: "uint8array" });
  // Node's Uint8Array<ArrayBufferLike> vs. lib.dom's BodyInit (which wants
  // ArrayBuffer specifically) is a known TS typing friction, not a real
  // runtime mismatch — NextResponse accepts it fine.
  return new NextResponse(archive as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="cms-posts-export.zip"`,
    },
  });
}
