import { NextRequest, NextResponse } from "next/server";
import matter from "gray-matter";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { applyPostImport } from "@/lib/post-sync";
import { prisma } from "@/lib/db";
import { writingSaveCheckpoints } from "@/lib/post-revisions";
import { exportFilename } from "@/lib/post-frontmatter";
import type { PermissionName } from "@/lib/rbac";
import {
  editFileVersion,
  editKeyFromRequest,
  etagOf,
  prepareEditUpload,
  serializeEditFile,
  versionFromHeader,
  type EditKeyAuth,
} from "@/lib/post-edit-keys";

// The shared core of an editing session's two surfaces — /api/edit/file (the
// plugin's local sync tool, Markdown + frontmatter) and /api/edit/doc (the
// in-browser writer editor, JSON). Both authenticate the same one-post edit
// key, and both save through saveEdit() so the If-Match check, the
// status/id guards, the revision checkpointing and the session's
// last_write_at can't drift apart between them.

export function sessionEnded(): NextResponse {
  return NextResponse.json(
    { error: "This editing session has ended or the key is invalid. Open the post again to start a new one." },
    { status: 401 }
  );
}

async function loadPost(auth: EditKeyAuth) {
  return auth.db.post.findUnique({
    where: { id: auth.key.post_id },
    include: { category: { select: { slug: true } } },
  });
}

export type EditPost = NonNullable<Awaited<ReturnType<typeof loadPost>>>;

/** Resolve the key, check the permission, and load the key's post. */
export async function authorizeEdit(
  req: NextRequest,
  permission: PermissionName
): Promise<{ auth: EditKeyAuth; post: EditPost; error?: never } | { error: NextResponse }> {
  const auth = await editKeyFromRequest(req);
  if (!auth) return { error: sessionEnded() };
  if (!auth.actor.permissions.has(permission)) {
    return { error: NextResponse.json({ error: "Forbidden", missing_permissions: [permission] }, { status: 403 }) };
  }
  const post = await loadPost(auth);
  if (!post) return { error: NextResponse.json({ error: "This post no longer exists." }, { status: 404 }) };
  const outOfScope = siteScopeRefusal(auth.key, post.platforms, permission === "content:view" ? "read" : "change");
  if (outOfScope) return { error: outOfScope };
  return { auth, post };
}

/** True when the caller's If-None-Match already names this version. */
export function notModified(req: NextRequest, post: EditPost): NextResponse | null {
  const version = editFileVersion(post);
  if (versionFromHeader(req.headers.get("if-none-match")) !== version) return null;
  return new NextResponse(null, { status: 304, headers: { etag: etagOf(version), "cache-control": "no-store" } });
}

function conflict(version: string): NextResponse {
  return NextResponse.json(
    { error: "The post was changed elsewhere since this version was loaded.", version },
    { status: 409, headers: { etag: etagOf(version) } }
  );
}

/**
 * Save `raw` (a whole post file: frontmatter + Markdown body) as the key's
 * post. Requires If-Match naming the version it was based on (428 without,
 * 409 when the post moved on). Returns the saved post, or the error response.
 */
export async function saveEdit(
  req: NextRequest,
  auth: EditKeyAuth,
  post: EditPost,
  raw: string
): Promise<{ saved: EditPost; warning?: string; error?: never } | { error: NextResponse }> {
  const expected = versionFromHeader(req.headers.get("if-match"));
  if (!expected) {
    return {
      error: NextResponse.json(
        { error: "If-Match is required: send the ETag of the version this edit was based on." },
        { status: 428 }
      ),
    };
  }
  const current = editFileVersion(post);
  if (expected !== current) return { error: conflict(current) };

  const prepared = prepareEditUpload(raw, post);
  if ("error" in prepared) return { error: NextResponse.json({ error: prepared.error }, { status: 400 }) };

  const now = new Date();
  const result = await applyPostImport({
    raw: prepared.raw,
    filename: exportFilename(post.slug),
    actor: auth.actor,
    db: auth.db,
    onConflict: "reject",
    siteScope: auth.key.site_scopes,
    revision: { snapshot: writingSaveCheckpoints(auth.key.last_write_at, now), source: "writing" },
  });

  switch (result.kind) {
    case "error":
      return {
        error: NextResponse.json(
          { error: result.message, ...(result.details && { details: result.details }) },
          { status: result.status }
        ),
      };
    case "conflict": {
      // Lost the race between the version check above and the write.
      const latest = await loadPost(auth);
      return { error: conflict(latest ? editFileVersion(latest) : current) };
    }
    case "applied": {
      await prisma.postEditKey.update({ where: { id: auth.key.id }, data: { last_write_at: now } });
      const saved = await loadPost(auth);
      if (!saved) return { error: NextResponse.json({ error: "This post no longer exists." }, { status: 404 }) };
      return { saved, warning: result.warning };
    }
  }
}

// ── The writer editor's JSON view of a post ─────────────────────────────────

export type EditDoc = {
  version: string;
  /** Who is editing, and in which organization: shown in the page header so
   *  a writer with several accounts can see which one this is. */
  account: string;
  organization: string;
  title: string;
  excerpt: string;
  body: string;
  content_format: string;
  slug: string;
  status: string;
  workflow_status: string;
  platforms: string[];
  /** The post's metadata, edited in the editor's Details panel. */
  details: EditDetails;
  post_id: string;
};

/** Metadata the writer editor's Details panel edits. Empty string = none. */
export type EditDetails = {
  slug: string;
  category: string;
  tags: string[];
  platforms: string[];
  featured_image: string;
  featured_image_alt: string;
  meta_description: string;
  meta_keywords: string;
};

export const DETAIL_KEYS = [
  "slug",
  "category",
  "tags",
  "platforms",
  "featured_image",
  "featured_image_alt",
  "meta_description",
  "meta_keywords",
] as const satisfies readonly (keyof EditDetails)[];

export function detailsOf(post: EditPost): EditDetails {
  return {
    slug: post.slug,
    category: post.category?.slug ?? "",
    tags: post.tags,
    platforms: post.platforms,
    featured_image: post.featured_image ?? "",
    featured_image_alt: post.featured_image_alt ?? "",
    meta_description: post.meta_description ?? "",
    meta_keywords: post.meta_keywords ?? "",
  };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_MAX = 2000;

/**
 * Validate a partial Details update from the editor. Unknown keys are
 * ignored; a key that is present must have the right shape.
 */
export function parseDetails(input: unknown): { details: Partial<EditDetails> } | { error: string } {
  if (input === undefined || input === null) return { details: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "details must be an object" };
  const o = input as Record<string, unknown>;
  const out: Partial<EditDetails> = {};
  for (const key of DETAIL_KEYS) {
    const v = o[key];
    if (v === undefined) continue;
    if (key === "tags" || key === "platforms") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { error: `${key} must be a list of strings` };
      const list = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
      if (key === "platforms" && list.length === 0) return { error: "A post needs at least one site." };
      if (list.length > 50) return { error: `Too many ${key}.` };
      out[key] = list;
      continue;
    }
    if (typeof v !== "string") return { error: `${key} must be a string` };
    if (v.length > TEXT_MAX) return { error: `${key} is longer than ${TEXT_MAX} characters` };
    if (key === "slug" && !SLUG_RE.test(v)) {
      return { error: "The URL slug can use lowercase letters, numbers and single hyphens only (like my-first-post)." };
    }
    out[key] = v.trim();
  }
  return { details: out };
}

export function toEditDoc(post: EditPost, auth: EditKeyAuth): EditDoc {
  return {
    version: editFileVersion(post),
    account: auth.actor.user.email,
    organization: auth.actor.organizations.find((o) => o.id === post.organization_id)?.name ?? "",
    title: post.title,
    excerpt: post.excerpt ?? "",
    body: post.content ?? "",
    content_format: post.content_format,
    slug: post.slug,
    status: post.status,
    workflow_status: post.workflow_status,
    platforms: post.platforms,
    details: detailsOf(post),
    post_id: post.id,
  };
}

/**
 * The whole post file with the editor's fields swapped in. Every other
 * frontmatter key (tags, category, sites, SEO fields, preserved metadata)
 * comes from the post as it is, so the editor can't drop what it doesn't show.
 */
export function editDocToFile(
  post: EditPost,
  edit: { title?: string; excerpt?: string; body: string; details?: Partial<EditDetails> }
): string {
  // A copy: gray-matter caches each parse by its input string and hands back
  // the SAME data object, so writing into it leaked this save's fields into
  // the next parse of an identical file.
  const data: Record<string, unknown> = { ...matter(serializeEditFile(post)).data };
  if (edit.title !== undefined) data.title = edit.title;
  if (edit.excerpt !== undefined) data.excerpt = edit.excerpt;
  // An emptied field is written as "" (the import clears it); an unchanged
  // one is left as the post has it.
  for (const [key, value] of Object.entries(edit.details ?? {})) data[key] = value;
  return matter.stringify(edit.body, data);
}
