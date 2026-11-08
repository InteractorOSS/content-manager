import { imageSize } from "image-size";
import type { TenantDb } from "@/lib/tenant-db";
import type { Actor } from "@/lib/rbac";
import { storeMediaFile } from "@/lib/media-storage";

// One uploaded file → stored (S3, or public/uploads in dev) and registered as
// a Media row. Shared by the media library upload (/api/cms/media) and the
// writer editor's image uploads (/api/edit/media), so the naming scheme and
// dimension probing can't drift apart.

export async function saveUploadedMedia(
  db: TenantDb,
  actor: Actor,
  file: File,
  meta: { alt_text?: string | null; caption?: string | null } = {}
) {
  const buffer = Buffer.from(await file.arrayBuffer());

  // Sanitize filename and make unique
  const ext = file.name.split(".").pop() ?? "";
  const base = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const filename = `${Date.now()}-${base}.${ext}`;

  const filePath = await storeMediaFile(buffer, filename, file.type);

  // Probe image dimensions (best-effort; non-images and odd formats stay null)
  let width: number | null = null;
  let height: number | null = null;
  if (file.type.startsWith("image/")) {
    try {
      const dims = imageSize(buffer);
      width = dims.width ?? null;
      height = dims.height ?? null;
    } catch {
      // not a probeable image
    }
  }

  return db.media.create({
    data: {
      filename,
      original_filename: file.name,
      file_path: filePath,
      file_size: file.size,
      mime_type: file.type,
      alt_text: meta.alt_text ?? null,
      caption: meta.caption ?? null,
      width,
      height,
      uploaded_by: actor.user.id,
    },
  });
}
