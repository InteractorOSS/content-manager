import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { canEditPost, type Actor } from "@/lib/rbac";

// Draft preview links (goal G#13): a stateless, signed, expiring token that
// lets a reviewer open an unpublished post without a CMS session. The token
// carries no state of its own — it is a signature over `post_id + expiresAt`
// keyed on NEXTAUTH_SECRET — so verifying it never touches the database. The
// "one active link per post" model (Post.preview_token_expires_at) is what
// makes revocation cheap: clearing/replacing that column immediately
// invalidates every previously issued token for the post, without a
// separate blocklist, because a real DB round-trip against that column is
// the second half of resolvePreviewLink below.

export const PREVIEW_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(postId: string, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`${postId}.${expiresAt}`).digest("base64url");
}

/** Mint a signed token for `postId`, opaque and URL-safe. */
export function signPreviewToken(
  postId: string,
  expiresAt: number,
  secret: string = env.NEXTAUTH_SECRET
): string {
  const sig = sign(postId, expiresAt, secret);
  return Buffer.from(`${postId}.${expiresAt}.${sig}`, "utf8").toString("base64url");
}

export type VerifiedPreviewToken = { postId: string; expiresAt: number };

/**
 * Verify a token's signature and shape only — it does NOT check expiry or
 * consult the database (see resolvePreviewLink for the full check). Returns
 * null for anything malformed or tampered; the signature comparison is
 * constant-time so a forger can't use response timing to guess bytes.
 */
export function verifyPreviewToken(
  token: string,
  secret: string = env.NEXTAUTH_SECRET
): VerifiedPreviewToken | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(".");
  if (parts.length !== 3) return null;
  const [postId, expiresAtRaw, sig] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!postId || !sig || !Number.isFinite(expiresAt)) return null;

  const expected = Buffer.from(sign(postId, expiresAt, secret));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  return { postId, expiresAt };
}

/** Mint a fresh token + its expiry, `ttlMs` from now (default 7 days). */
export function mintPreviewToken(
  postId: string,
  ttlMs: number = PREVIEW_LINK_TTL_MS,
  now: number = Date.now()
): { token: string; expiresAt: Date } {
  const expiresAtMs = now + ttlMs;
  return { token: signPreviewToken(postId, expiresAtMs), expiresAt: new Date(expiresAtMs) };
}

/** Absolute, openable preview URL for a token. */
export function previewUrl(token: string): string {
  return new URL(`/preview/${token}`, env.NEXTAUTH_URL).toString();
}

/** The preview_url a live get_post/CMS response should surface, or null. */
export function livePreviewUrl(post: { id: string; preview_token_expires_at: Date | null }, now: number = Date.now()): string | null {
  if (!post.preview_token_expires_at || post.preview_token_expires_at.getTime() <= now) return null;
  return previewUrl(signPreviewToken(post.id, post.preview_token_expires_at.getTime()));
}

/**
 * The single source of truth for "should THIS caller see this post's live
 * preview_url" — a preview link is a bypass credential (opens the post with
 * no CMS session), so it must never be handed to a caller who couldn't have
 * minted or revoked it themselves. Mirrors the same canEditPost gate the
 * create/revoke endpoint enforces; every CMS route that formats a Post for
 * a response must call this rather than including preview_url unconditionally.
 */
export function previewUrlForActor(
  actor: Actor,
  post: { id: string; author_id: string | null; preview_token_expires_at: Date | null }
): string | null {
  return canEditPost(actor, post) ? livePreviewUrl(post) : null;
}

/** Strip the internal expiry column from a post before it leaves the server
 *  — every response uses the derived preview_url (via previewUrlForActor or
 *  null) instead, never the raw timestamp. */
export function omitPreviewToken<T extends { preview_token_expires_at?: unknown }>(
  post: T
): Omit<T, "preview_token_expires_at"> {
  const { preview_token_expires_at: _omit, ...rest } = post;
  return rest;
}

export type PreviewResolution =
  | { status: 200; post: NonNullable<Awaited<ReturnType<typeof prisma.post.findUnique>>> }
  | { status: 404 }
  | { status: 410 };

/**
 * Full resolution of a preview token: signature + expiry + "is this still
 * the post's CURRENT active link" (a token superseded by a later mint, or
 * cleared by revocation, fails this even before its own embedded expiry).
 * 404 covers anything that must never distinguish "wrong" from "gone"
 * (tampered, revoked, post deleted); 410 is reserved for a token whose own
 * embedded expiry has simply passed.
 */
export async function resolvePreviewLink(token: string, now: number = Date.now()): Promise<PreviewResolution> {
  const verified = verifyPreviewToken(token);
  if (!verified) return { status: 404 };
  if (verified.expiresAt <= now) return { status: 410 };

  const post = await prisma.post.findUnique({ where: { id: verified.postId } });
  if (!post) return { status: 404 };
  if (!post.preview_token_expires_at || post.preview_token_expires_at.getTime() !== verified.expiresAt) {
    return { status: 404 };
  }
  return { status: 200, post };
}

/**
 * Opaque change marker for a previewed post, polled by the preview page's
 * live-reload script. `updated_at` is Prisma-managed (@updatedAt) and moves on
 * every write — title, body, excerpt, image — which is exactly "should the
 * preview re-render", whereas content_hash covers only body + metadata.
 */
export function previewVersion(post: { updated_at: Date }): string {
  return String(post.updated_at.getTime());
}
