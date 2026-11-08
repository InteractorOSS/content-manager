import { NextRequest, NextResponse } from "next/server";
import { editFileVersion, etagOf, serializeEditFile } from "@/lib/post-edit-keys";
import { authorizeEdit, notModified, saveEdit } from "@/lib/edit-session";

// The live-sync file endpoint for the Interactor CMS plugin. Authenticated
// ONLY by a one-post edit key (cms_edit_..., see src/lib/post-edit-keys.ts) —
// the key names the post, so there is no id in the URL to guess at.
//
//   GET  → the post as Markdown + frontmatter, ETag = version
//          (If-None-Match → 304, so the tool can poll cheaply)
//   PUT  → body is the file; If-Match is required, 409 when the post moved on
//
// Saving is shared with /api/edit/doc (src/lib/edit-session.ts): one revision
// checkpoint per session and after each pause, never one per save.

function fileResponse(file: string, version: string): NextResponse {
  return new NextResponse(file, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      etag: etagOf(version),
      "cache-control": "no-store",
    },
  });
}

export async function GET(req: NextRequest) {
  const session = await authorizeEdit(req, "content:view");
  if (session.error) return session.error;
  return notModified(req, session.post) ?? fileResponse(serializeEditFile(session.post), editFileVersion(session.post));
}

export async function PUT(req: NextRequest) {
  const session = await authorizeEdit(req, "content:edit");
  if (session.error) return session.error;
  const result = await saveEdit(req, session.auth, session.post, await req.text());
  if (result.error) return result.error;
  const res = fileResponse(serializeEditFile(result.saved), editFileVersion(result.saved));
  if (result.warning) res.headers.set("x-cms-warning", result.warning);
  return res;
}
