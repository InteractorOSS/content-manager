import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canEditPost, editPostRefusalMessage, loadActor } from "@/lib/rbac";
import { editKeyFromRequest, mintEditKey } from "@/lib/post-edit-keys";
import { mintBrowseKey } from "@/lib/post-browse-keys";
import { publicOrigin } from "@/lib/oauth/protocol";

// Open a post in the writer editor from the browser sign-in: what a link like
// /write?post=<id> uses, so a list of posts can be plain clickable links with
// no secret in them. The page POSTs here with the CMS session cookie and gets
// back a one-post edit key for itself.
//
// The post's organization decides the org, not the session's current one: a
// link in a list may point into any organization the signed-in person
// belongs to. Membership is checked with loadActor(forceOrganizationId) and
// the resolved org compared, the same refusal a token gets, so a post in an
// organization this account isn't in is refused — without naming that
// organization, since the post id alone shouldn't reveal whose it is.
export async function POST(req: NextRequest) {
  // The session cookie is SameSite=Lax, so a cross-site POST doesn't carry
  // it anyway; checking Origin as well costs nothing.
  const origin = req.headers.get("origin");
  if (origin && origin !== publicOrigin() && origin !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { post_id?: unknown; list?: unknown } | null;
  const postId = typeof body?.post_id === "string" ? body.post_id : "";
  const wantsList = body?.list === true;
  if (!postId && !wantsList) return NextResponse.json({ error: "post_id is required" }, { status: 400 });

  const session = await auth();
  if (!session?.user || session.error) {
    return NextResponse.json(
      { error: wantsList ? "Sign in to the CMS to see your posts." : "Sign in to the CMS to open this post.", sign_in: true },
      { status: 401 }
    );
  }

  // { list: true }: a browse key for /write/posts opened as a plain page (the
  // editor's "All posts" when it was opened from a link, not by Claude),
  // for the signed-in account's current organization, every site.
  if (wantsList) {
    const actor = await loadActor(session.user);
    if (!actor?.organizationId || !actor.permissions.has("content:view")) {
      return NextResponse.json({ error: "This account has no organization whose posts it can read." }, { status: 403 });
    }
    const { key } = await mintBrowseKey({
      userId: actor.user.id,
      organizationId: actor.organizationId,
      apiTokenId: null,
      siteScopes: [],
      site: null,
      replacePrevious: false,
    });
    return NextResponse.json({ data: { list_key: key } });
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  const notYours = (email?: string | null) =>
    NextResponse.json(
      {
        error: `${email ?? "This account"} can't open this post. It may belong to another account's organization: sign in to the CMS as that account and click the link again.`,
        switch_account: true,
      },
      { status: 403 }
    );
  if (!post) return notYours(session.user.email);

  const actor = await loadActor(session.user, { forceOrganizationId: post.organization_id });
  if (!actor || actor.organizationId !== post.organization_id) return notYours(session.user.email);
  if (!actor.permissions.has("content:edit")) {
    return NextResponse.json(
      { error: "Your role in this organization can read posts but not edit them.", missing_permissions: ["content:edit"] },
      { status: 403 }
    );
  }
  if (!canEditPost(actor, post)) {
    return NextResponse.json({ error: editPostRefusalMessage(post) }, { status: 403 });
  }

  const { key, expiresAt } = await mintEditKey({
    postId: post.id,
    userId: actor.user.id,
    organizationId: post.organization_id,
    apiTokenId: null,
    siteScopes: [],
    source: "browser",
  });
  return NextResponse.json({ data: { edit_key: key, edit_key_expires_at: expiresAt.toISOString() } });
}

// End an editing session: the sync tool calls this with its own key when the
// writer stops, so the key doesn't sit live until it expires.
export async function DELETE(req: NextRequest) {
  const auth = await editKeyFromRequest(req);
  if (auth) {
    await prisma.postEditKey.update({ where: { id: auth.key.id }, data: { revoked_at: new Date() } });
  }
  // Idempotent: an already-ended session is the outcome the caller wanted.
  return new NextResponse(null, { status: 204 });
}
