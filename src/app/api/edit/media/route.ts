import { NextRequest, NextResponse } from "next/server";
import { authorizeEdit } from "@/lib/edit-session";
import { saveUploadedMedia } from "@/lib/media-upload";
import { mediaStorageErrorResponse } from "@/lib/media-storage";

// Image uploads from the writer editor (/write): the featured image and
// pictures in the text. Stored like any media-library upload and returned as
// a URL; the page then puts it in the post (the featured image through a
// normal save, an in-text image as Markdown in the body), so the post itself
// only ever changes through the one save path.
//
//   POST multipart { file, alt_text? } → { data: { url, alt_text, width, height, media_id } }

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await authorizeEdit(req, "content:edit");
  if (session.error) return session.error;
  if (!session.auth.actor.permissions.has("media:upload")) {
    return NextResponse.json(
      { error: "Your role in this organization can't upload images.", missing_permissions: ["media:upload"] },
      { status: 403 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No image was attached." }, { status: 400 });
  if (!IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "That isn't an image this editor takes (PNG, JPEG, GIF, WebP or AVIF)." }, { status: 415 });
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return NextResponse.json({ error: "That image is larger than 10 MB. Make it smaller and try again." }, { status: 413 });
  }

  const alt = form?.get("alt_text")?.toString().trim() || null;
  let media;
  try {
    media = await saveUploadedMedia(session.auth.db, session.auth.actor, file, { alt_text: alt });
  } catch (err) {
    const refusal = mediaStorageErrorResponse(err);
    if (refusal) return refusal;
    throw err;
  }
  return NextResponse.json(
    { data: { url: media.file_path, alt_text: media.alt_text, width: media.width, height: media.height, media_id: media.id } },
    { status: 201 }
  );
}
