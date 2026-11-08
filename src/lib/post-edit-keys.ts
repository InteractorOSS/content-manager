import { randomBytes } from "crypto";
import matter from "gray-matter";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/api-tokens";
import { loadActor, type Actor } from "@/lib/rbac";
import { tenantDb, type TenantDb } from "@/lib/tenant-db";
import { serializePostFile, type ExportablePost } from "@/lib/post-frontmatter";

// One-post edit keys — the credential the Interactor CMS plugin's local
// sync tool uses to keep a writer's Markdown file and the CMS in step.
//
// Why a separate credential at all: the writer signs in once, to the CMS
// connector, and Claude holds that OAuth token where a separate local process
// can't read it. So `open_for_editing` (MCP) mints one of these and Claude
// hands it to the sync tool. It is deliberately much weaker than the token
// that minted it, which is what makes minting it through the API acceptable
// when API tokens themselves can only be minted from a browser session:
//
//   - it reaches ONE post, through /api/edit/* only — `looksLikeApiToken`
//     rejects the prefix, so no /api/cms route or /api/mcp accepts it;
//   - it expires after EDIT_KEY_TTL_MS and can't mint or extend anything;
//   - it dies with its minting token (FK cascade, plus a live revocation
//     check below), so disconnecting Claude ends every session it opened;
//   - permissions are re-read from the owner's membership on every request,
//     exactly like a PAT, and the minting token's site scope is copied onto it.

export const EDIT_KEY_PREFIX = "cms_edit_";
export const EDIT_KEY_TTL_MS = 8 * 60 * 60 * 1000;

export function generateEditKey(): string {
  return `${EDIT_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function looksLikeEditKey(value: string): boolean {
  return value.startsWith(EDIT_KEY_PREFIX);
}

/**
 * Mint a key for (post, user). A key the same person already holds for the
 * same post THROUGH THE SAME CONNECTION AND SOURCE (the same minting token,
 * or the browser sign-in when apiTokenId is null; opened by Claude, a link,
 * or the post list) is revoked first: reopening a post replaces that session
 * rather than stacking keys that are only ever used once. Other sessions are
 * left alone, so opening a post from a link or the list never cuts off a sync
 * Claude is running for it.
 */
export type EditKeySource = "connection" | "browser" | "list";

export async function mintEditKey(input: {
  postId: string;
  userId: string;
  organizationId: string;
  apiTokenId: string | null;
  siteScopes: string[];
  /** How the session was opened (see PostEditKey.source). Only a session of
   *  the same source and connection is replaced. */
  source?: EditKeySource;
  now?: number;
}): Promise<{ key: string; expiresAt: Date }> {
  const source = input.source ?? "connection";
  const now = input.now ?? Date.now();
  const key = generateEditKey();
  const expiresAt = new Date(now + EDIT_KEY_TTL_MS);
  await prisma.$transaction([
    prisma.postEditKey.updateMany({
      where: {
        post_id: input.postId,
        user_id: input.userId,
        api_token_id: input.apiTokenId,
        source,
        revoked_at: null,
      },
      data: { revoked_at: new Date(now) },
    }),
    prisma.postEditKey.create({
      data: {
        post_id: input.postId,
        user_id: input.userId,
        organization_id: input.organizationId,
        api_token_id: input.apiTokenId,
        site_scopes: input.siteScopes,
        key_hash: hashToken(key),
        expires_at: expiresAt,
        source,
      },
    }),
  ]);
  return { key, expiresAt };
}

export type EditKeyAuth = {
  actor: Actor;
  db: TenantDb;
  key: { id: string; post_id: string; site_scopes: string[]; last_write_at: Date | null };
};

/**
 * Resolve a raw key to the post it opens and the person acting through it, or
 * null for anything that isn't a live key — same tenancy rules as
 * actorFromApiTokenValue: the org is the key's, never a fallback membership.
 */
export async function resolveEditKey(raw: string, now: Date = new Date()): Promise<EditKeyAuth | null> {
  if (!looksLikeEditKey(raw)) return null;

  const key = await prisma.postEditKey.findUnique({
    where: { key_hash: hashToken(raw) },
    include: { api_token: { select: { revoked_at: true, expires_at: true } } },
  });
  if (!key || key.revoked_at || key.expires_at <= now) return null;
  // A connector access token rotates in place (same row), so its own
  // expires_at is not a reason to end the session — but a revoked or expired
  // row means the connection is gone, and so is everything it opened.
  if (key.api_token && key.api_token.revoked_at) return null;

  const actor = await loadActor({ id: key.user_id }, { forceOrganizationId: key.organization_id });
  if (!actor || actor.organizationId !== key.organization_id) return null;

  prisma.postEditKey
    .update({ where: { id: key.id }, data: { last_used_at: now } })
    .catch(() => {});

  return {
    actor,
    db: tenantDb(key.organization_id),
    key: {
      id: key.id,
      post_id: key.post_id,
      site_scopes: key.site_scopes || [],
      last_write_at: key.last_write_at ?? null,
    },
  };
}

export async function editKeyFromRequest(req: NextRequest): Promise<EditKeyAuth | null> {
  const header = req.headers.get("authorization");
  if (!header || !/^bearer /i.test(header)) return null;
  return resolveEditKey(header.slice("bearer ".length).trim());
}

/** Opaque version of the post as the sync tool sees it. `updated_at` moves on
 *  every write (title included), unlike content_hash (body + metadata only). */
export function editFileVersion(post: { updated_at: Date }): string {
  return String(post.updated_at.getTime());
}

/** The ETag header value for a version, and the version inside an
 *  If-Match / If-None-Match header (quotes and a weak prefix tolerated). */
export function etagOf(version: string): string {
  return `"${version}"`;
}
export function versionFromHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^(?:W\/)?"?([^"]*)"?$/.exec(header.trim());
  return match?.[1] || null;
}

/**
 * The post as the sync tool's file. content_hash is left out on purpose: the
 * version travels in ETag/If-Match instead, so a save never has to rewrite a
 * frontmatter line in the file the writer is typing in.
 */
export function serializeEditFile(post: ExportablePost): string {
  return serializePostFile({ ...post, content_hash: null });
}

export type PreparedUpload = { raw: string } | { error: string };

/**
 * Turn an uploaded file into what applyPostImport expects for this post:
 * pinned to the key's post id and carrying the post's current content_hash
 * (the import's own compare-and-set, closing the race between the If-Match
 * check and the write). Status can't move from the file — a key is for
 * writing, and submit/approve/publish stay in the workflow tools where the
 * review rules apply visibly.
 */
export function prepareEditUpload(
  raw: string,
  post: { id: string; status: string; content_hash: string | null }
): PreparedUpload {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    return { error: `The frontmatter isn't valid YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  const data: Record<string, unknown> = { ...parsed.data };

  if (data.id !== undefined && data.id !== post.id) {
    return { error: `This file belongs to post ${String(data.id)}, but this editing session is for post ${post.id}.` };
  }
  if (data.status !== undefined && data.status !== post.status) {
    return {
      error: `The status can't be changed from the file (it says "${String(data.status)}", the post is "${post.status}"). Change it back, and submit or publish through the CMS workflow instead.`,
    };
  }

  data.id = post.id;
  delete data.content_hash;
  if (post.content_hash) data.content_hash = post.content_hash;
  return { raw: matter.stringify(parsed.content, data) };
}
