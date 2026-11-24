import { NextRequest, NextResponse } from "next/server";
import { editFileVersion, etagOf, serializeEditFile, versionFromHeader } from "@/lib/post-edit-keys";
import { saveEdit } from "@/lib/edit-session";
import { canEditPost, editPostRefusalMessage } from "@/lib/rbac";
import { authorizeMirror, loadMirrorPost } from "@/lib/mirror-session";

// One post of the mirror's workspace as a file: ?id=<post id>.
//
//   GET → the same Markdown + frontmatter /api/edit/file serves, ETag = version
//         (If-None-Match → 304)
//   PUT → save it back, through the same saveEdit() an edit key's save uses:
//         If-Match required (409 when the post moved on), the file can't
//         change `id` or `status`, and the save is checked like opening the
//         post for editing (content:edit, own posts unless content:edit_any,
//         every site the post targets inside the token's scope).
//
// There is no POST or DELETE: the mirror never creates a post, and a file
// deleted locally never deletes one.

function fileResponse(file: string, version: string): NextResponse {
  return new NextResponse(file, {
    headers: { "content-type": "text/markdown; charset=utf-8", etag: etagOf(version), "cache-control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const session = await authorizeMirror(req, "content:view");
  if (session.error) return session.error;
  const loaded = await loadMirrorPost(session.auth, req.nextUrl.searchParams.get("id") ?? "", "read");
  if (loaded.error) return loaded.error;
  const version = editFileVersion(loaded.post);
  if (versionFromHeader(req.headers.get("if-none-match")) === version) {
    return new NextResponse(null, { status: 304, headers: { etag: etagOf(version), "cache-control": "no-store" } });
  }
  return fileResponse(serializeEditFile(loaded.post), version);
}

export async function PUT(req: NextRequest) {
  const session = await authorizeMirror(req, "content:edit");
  if (session.error) return session.error;
  const { auth } = session;
  const loaded = await loadMirrorPost(auth, req.nextUrl.searchParams.get("id") ?? "", "change");
  if (loaded.error) return loaded.error;
  const { post } = loaded;
  if (!canEditPost(auth.actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  const result = await saveEdit(
    req,
    {
      actor: auth.actor,
      db: auth.db,
      site_scopes: auth.key.site_scopes,
      // No per-post session row: a save after a pause in the post's own
      // history (any change, from anywhere) takes a revision checkpoint.
      last_write_at: post.updated_at,
      markWritten: async () => {},
    },
    post,
    await req.text()
  );
  if (result.error) return result.error;
  const res = fileResponse(serializeEditFile(result.saved), editFileVersion(result.saved));
  if (result.warning) res.headers.set("x-cms-warning", result.warning);
  return res;
}
