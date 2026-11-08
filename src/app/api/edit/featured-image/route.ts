import { NextRequest, NextResponse } from "next/server";
import { authorizeEdit } from "@/lib/edit-session";
import { generateFeaturedImage } from "@/lib/featured-image";
import { mediaStorageErrorResponse } from "@/lib/media-storage";

// "Generate title card" in the writer editor's Details panel: renders the
// free title-card image (src/lib/featured-image.tsx) and returns it. The page
// then sets it as the featured image through a normal save, like an upload.
export async function POST(req: NextRequest) {
  const session = await authorizeEdit(req, "content:edit");
  if (session.error) return session.error;
  try {
    const image = await generateFeaturedImage(session.auth.db, session.auth.actor, session.post);
    return NextResponse.json({ data: { url: image.url, alt_text: image.alt, media_id: image.media_id } }, { status: 201 });
  } catch (err) {
    const refusal = mediaStorageErrorResponse(err);
    if (refusal) return refusal;
    console.error("[featured-image] generation failed", err);
    return NextResponse.json({ error: "Couldn't make a title card. Try again." }, { status: 502 });
  }
}
