import { NextRequest, NextResponse } from "next/server";
import { previewVersion, resolvePreviewLink } from "@/lib/preview-link";

type Ctx = { params: Promise<{ token: string }> };

// Change marker for the live-reloading preview page (see LIVE_RELOAD_SCRIPT in
// ../route.ts). Same token checks as the page itself, and it answers with a
// version string only — never any of the post's content.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const result = await resolvePreviewLink(token);
  const headers = { "cache-control": "no-store" };

  if (result.status !== 200) {
    return NextResponse.json({ error: result.status === 410 ? "Expired" : "Not found" }, { status: result.status, headers });
  }
  return NextResponse.json({ version: previewVersion(result.post) }, { headers });
}
