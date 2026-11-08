import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { deleteFromS3ByUrl, isS3Configured } from "@/lib/s3";
import { unlink } from "fs/promises";
import { join } from "path";

 
function formatMedia(m: any) {
  return {
    ...m,
    inserted_at: m.inserted_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
  };
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "media:view");
  if (error) return error;

  const { id } = await params;
  const media = await db.media.findUnique({ where: { id } });
  if (!media) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ data: formatMedia(media) });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "media:delete");
  if (error) return error;

  const { id } = await params;
  const media = await db.media.findUnique({ where: { id } });
  if (!media) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Delete the underlying file (best-effort)
  try {
    if (media.file_path.startsWith("http")) {
      if (isS3Configured()) await deleteFromS3ByUrl(media.file_path);
    } else {
      await unlink(join(process.cwd(), "public", media.file_path));
    }
  } catch {
    // File may already be gone
  }

  await db.media.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
