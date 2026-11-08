import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import { generateFeaturedImage } from "@/lib/featured-image";
import { mediaStorageErrorResponse } from "@/lib/media-storage";

type Ctx = { params: Promise<{ id: string }> };

// Generate a title-card featured image for the post (src/lib/featured-image.tsx:
// rendered on this server, no external service, no cost) and set it as the
// post's featured_image. Replaces any existing featured image — the caller
// asked for a new one — and fills featured_image_alt only when it's empty, so a
// hand-written alt text survives regeneration. Same bar as editing the post.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  let image;
  try {
    image = await generateFeaturedImage(db, actor, post);
  } catch (err) {
    const refusal = mediaStorageErrorResponse(err);
    if (refusal) return refusal;
    console.error("[featured-image] generation failed", err);
    return NextResponse.json({ error: "Could not generate a featured image — try again" }, { status: 502 });
  }

  const updated = await db.post.update({
    where: { id },
    data: {
      featured_image: image.url,
      ...(!post.featured_image_alt?.trim() && { featured_image_alt: image.alt }),
    },
    select: { id: true, featured_image: true, featured_image_alt: true },
  });

  return NextResponse.json({ data: { ...updated, media_id: image.media_id } }, { status: 201 });
}
