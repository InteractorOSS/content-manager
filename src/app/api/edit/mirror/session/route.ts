import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { mirrorKeyFromRequest } from "@/lib/post-browse-keys";

// End the folder mirror: the plugin's mirror calls this with its own key when
// it stops, so the key doesn't stay live until it expires. Idempotent.
export async function DELETE(req: NextRequest) {
  const auth = await mirrorKeyFromRequest(req);
  if (auth) {
    await prisma.postBrowseKey.update({ where: { id: auth.key.id }, data: { revoked_at: new Date() } });
  }
  return new NextResponse(null, { status: 204 });
}
