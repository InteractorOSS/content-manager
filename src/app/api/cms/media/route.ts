import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { saveUploadedMedia } from "@/lib/media-upload";
import { mediaStorageErrorResponse } from "@/lib/media-storage";

 
function formatMedia(m: any) {
  return {
    ...m,
    inserted_at: m.inserted_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const { db, error } = await requirePermissionApi(req, "media:view");
  if (error) return error;

  const media = await db.media.findMany({
    orderBy: { inserted_at: "desc" },
  });
  return NextResponse.json({ data: media.map(formatMedia) });
}

export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermissionApi(req, "media:upload");
  if (error) return error;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  let media;
  try {
    media = await saveUploadedMedia(db, actor, file, {
      alt_text: formData.get("alt_text")?.toString() ?? null,
      caption: formData.get("caption")?.toString() ?? null,
    });
  } catch (err) {
    const refusal = mediaStorageErrorResponse(err);
    if (refusal) return refusal;
    throw err;
  }

  return NextResponse.json({ data: formatMedia(media) }, { status: 201 });
}
