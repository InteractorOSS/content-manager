import { Prisma } from "@prisma/client";
import { isUniqueViolation, isRecordNotFound } from "@/lib/db";
import { canEditPost, editPostRefusalMessage, type Actor, authorDisplayName } from "@/lib/rbac";
import type { TenantDb } from "@/lib/tenant-db";
import { sanitizePostContent } from "@/lib/sanitize";
import { computeContentHash, computeContentHtml } from "@/lib/markdown";
import { stripHtml, generateSlug } from "@/lib/utils";
import { parseSiteSlugs, DEFAULT_SITE_SLUGS } from "@/lib/sites";
import { orgSiteSlugs } from "@/lib/sites-server";
import { siteScopeAllows, siteScopeRefusalMessage } from "@/lib/token-site-scope";
import { pruneOldRevisions, revisionSnapshotData, type PostRevisionSource } from "@/lib/post-revisions";
import {
  parsePostFile,
  FrontmatterValidationError,
  MetadataValidationError,
  type PostFrontmatter,
  type PostMetadata,
} from "@/lib/post-frontmatter";
import { postConflictBody } from "@/lib/post-conflict";
import { notifyIndexNowForPost } from "@/lib/indexnow";

function readingTime(html: string): number {
  const words = stripHtml(html).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function formatPost(post: Record<string, unknown> & { inserted_at: Date; updated_at: Date; published_at: Date | null }) {
  return {
    ...post,
    inserted_at: post.inserted_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
    published_at: post.published_at?.toISOString() ?? null,
  };
}

export interface ApplyPostImportOptions {
  raw: string;
  filename?: string;
  actor: Actor;
  db: TenantDb;
  force?: boolean;
  /**
   * "reject" (default, HTTP import): a hash conflict returns a `conflict`
   * result the caller turns into a 409 — there's an interactive human on
   * the other end who can re-pull and retry.
   * "flag" (webhook/inbound git sync): no one is watching synchronously, so
   * instead of dropping the push, the existing post is marked
   * sync_conflict=true and left untouched — the CMS version stays
   * authoritative until a human resolves it (see FILE-BASED-CONTENT-PLAN.md
   * Phase 2).
   */
  onConflict?: "reject" | "flag";
  /**
   * The authenticating token's site scope (G#21) — absent for a session or the
   * webhook. A scoped import may only overwrite a post whose sites are all in
   * scope, and may only leave it targeting sites in scope.
   */
  siteScope?: string[];
  /**
   * Whether a content-changing write snapshots the outgoing version first
   * (default true), and under which source. A live-editing session passes
   * `snapshot: false` for all but its first save / the first after a pause,
   * since it saves every second or so — see writingSaveCheckpoints().
   */
  revision?: { snapshot?: boolean; source?: PostRevisionSource };
}

export type ApplyPostImportResult =
  | { kind: "applied"; post: Record<string, unknown>; created: boolean; warning?: string }
  | { kind: "conflict"; currentHash: string | null; conflict: ReturnType<typeof postConflictBody>; flagged?: boolean }
  | { kind: "error"; status: number; message: string; details?: string };

/**
 * The write side of file-based content sync (FILE-BASED-CONTENT-PLAN.md
 * Phase 1/2) — shared by the HTTP import route and the inbound GitHub
 * webhook so both apply the exact same rules: D3 (frontmatter id is the
 * identity, slug is authoritative, content_hash is the optimistic-
 * concurrency check) and D4 (status: published only takes effect if the
 * actor holds content:publish; otherwise it lands as pending_review).
 */
export async function applyPostImport(
  opts: ApplyPostImportOptions
): Promise<ApplyPostImportResult> {
  const { actor, db, force = false, onConflict = "reject" } = opts;

  let frontmatter: PostFrontmatter;
  let metadata: PostMetadata;
  let markdownBody: string;
  try {
    ({ frontmatter, metadata, body: markdownBody } = parsePostFile(opts.raw));
  } catch (e) {
    if (e instanceof FrontmatterValidationError) {
      return { kind: "error", status: 400, message: "Invalid frontmatter", details: e.message };
    }
    // Bounds on the free-form metadata bag — paraphrased for the caller
    // rather than surfaced as a database error further down.
    if (e instanceof MetadataValidationError) {
      return { kind: "error", status: 400, message: "Invalid frontmatter", details: e.message };
    }
    throw e;
  }

  const derivedSlug = generateSlug(
    opts.filename?.replace(/\.mdx?$/i, "") ?? frontmatter.title
  );
  const lookupSlug = frontmatter.slug || derivedSlug;

  const existing = frontmatter.id
    ? await db.post.findUnique({ where: { id: frontmatter.id } })
    : await db.post.findFirst({ where: { slug: lookupSlug } });

  if (frontmatter.id && !existing) {
    return { kind: "error", status: 404, message: `Post ${frontmatter.id} not found` };
  }

  const siteScope = opts.siteScope ?? [];
  if (existing && !siteScopeAllows(siteScope, existing.platforms, "change")) {
    return {
      kind: "error",
      status: 403,
      message: siteScopeRefusalMessage(siteScope, existing.platforms, "change"),
    };
  }

  if (existing && !canEditPost(actor, existing)) {
    return { kind: "error", status: 403, message: editPostRefusalMessage(existing) };
  }

  if (
    existing &&
    frontmatter.content_hash !== undefined &&
    frontmatter.content_hash !== existing.content_hash &&
    !force
  ) {
    if (onConflict === "flag") {
      const flagged = await db.post
        .update({ where: { id: existing.id }, data: { sync_conflict: true } })
        .catch((e) => {
          if (isRecordNotFound(e)) return null;
          throw e;
        });
      const current = flagged ?? (await db.post.findUnique({ where: { id: existing.id } }));
      if (!current) return { kind: "error", status: 404, message: `Post ${existing.id} not found` };
      return { kind: "conflict", currentHash: current.content_hash, conflict: postConflictBody(current), flagged: !!flagged };
    }
    return { kind: "conflict", currentHash: existing.content_hash, conflict: postConflictBody(existing) };
  }

  const slug = frontmatter.slug || existing?.slug || derivedSlug;
  const contentFormat = frontmatter.content_format ?? existing?.content_format ?? "markdown";
  const content = contentFormat === "markdown" ? markdownBody : sanitizePostContent(markdownBody);
  const contentHtml = content ? computeContentHtml(content, contentFormat) : null;

  let categoryId = existing?.category_id ?? null;
  if (frontmatter.category !== undefined && !frontmatter.category.trim()) {
    // An explicitly empty category clears it (the writer editor's "None").
    categoryId = null;
  } else if (frontmatter.category !== undefined) {
    const category = await db.category.findFirst({ where: { slug: frontmatter.category } });
    if (!category) {
      return { kind: "error", status: 400, message: `Unknown category "${frontmatter.category}"` };
    }
    categoryId = category.id;
  }

  // Sites (G#18): validated against this org's registry rather than a global
  // constant. An import is exactly the case the `alsoAllow` carve-out exists
  // for — a file may carry a slug this org never registered, and on a re-import
  // the post's existing slugs must stay valid rather than be quietly dropped.
  const platforms = parseSiteSlugs(
    frontmatter.platforms,
    await orgSiteSlugs(db, existing?.platforms ?? [])
  );
  if (platforms !== null && platforms.length === 0) {
    return { kind: "error", status: 400, message: "At least one valid site is required" };
  }
  const targetPlatforms = platforms ?? existing?.platforms ?? DEFAULT_SITE_SLUGS;
  if (!siteScopeAllows(siteScope, targetPlatforms, "target")) {
    const hint =
      platforms === null && !existing
        ? ` New posts target ${DEFAULT_SITE_SLUGS.join(", ")} unless the frontmatter lists platforms.`
        : "";
    return {
      kind: "error",
      status: 403,
      message: siteScopeRefusalMessage(siteScope, targetPlatforms, "target") + hint,
    };
  }

  const canPublish = actor.permissions.has("content:publish");
  const desiredStatus = frontmatter.status ?? existing?.status ?? "draft";
  const publishRequested = desiredStatus === "published";
  const statusChanging = desiredStatus !== (existing?.status ?? "draft");
  const statusGated = publishRequested && statusChanging && !canPublish;

  const status = statusGated ? (existing?.status ?? "draft") : desiredStatus;
  const workflowStatus = statusGated
    ? "pending_review"
    : status === "published"
      ? "approved"
      : (existing?.workflow_status ?? "draft");
  const warning = statusGated
    ? "You lack content:publish — the post was saved as pending_review; ask a reviewer to publish it."
    : undefined;

  if (status === "published" && !stripHtml(contentHtml ?? "").trim()) {
    return { kind: "error", status: 400, message: "Content is required to publish a post" };
  }

  const becamePublished = status === "published" && existing?.status !== "published";
  const becameUnpublished = status !== "published" && existing?.status === "published";
  // Metadata REPLACES rather than merges, unlike the `?? existing` fallbacks
  // used for scalar columns above. The file states a post's frontmatter in
  // full, so a key the author deleted from the file must actually go —
  // merging would make deletion inexpressible. The trade-off: importing a
  // file written before this post had metadata clears it, same as importing
  // one with an old title overwrites the title.
  const contentHash = content ? computeContentHash(content, metadata) : null;

  const resolvedExcerpt = frontmatter.excerpt ?? existing?.excerpt ?? null;

  // The same substantive-content test the CMS PUT route uses
  // (postContentChanged in src/lib/post-revisions.ts) — this write path
  // resolves its own values rather than a sparse patch, so it compares them
  // directly instead of calling that function, but the fields and the
  // question ("title/content/content_format/excerpt actually different?")
  // are the same.
  const contentChanged =
    !!existing &&
    (frontmatter.title !== existing.title ||
      (content || null) !== existing.content ||
      contentFormat !== existing.content_format ||
      resolvedExcerpt !== existing.excerpt);

  const data = {
    title: frontmatter.title,
    slug,
    content: content || null,
    content_html: contentHtml,
    content_hash: contentHash,
    updated_by_id: actor.user.id,
    updated_by_name: authorDisplayName(actor.user),
    // A successful write here is by definition in sync with what produced
    // it (an import from a file, whichever direction) — clears any earlier
    // conflict flag too.
    last_synced_hash: contentHash,
    sync_conflict: false,
    content_format: contentFormat,
    excerpt: resolvedExcerpt,
    // Honest "Updated <date>" (G#31): a brand new post is current by
    // definition; an existing one only advances when this import actually
    // changed substantive content, same gate as the revision snapshot below
    // — there is no `mark_updated` equivalent on this path (a file has no
    // verb to express "force it anyway," only state to declare).
    content_updated_at: !existing || contentChanged ? new Date() : undefined,
    status,
    workflow_status: workflowStatus,
    ...(becamePublished && {
      approved_at: new Date(),
      approved_by_id: actor.user.id,
      published_at: frontmatter.published_at ? new Date(frontmatter.published_at) : new Date(),
    }),
    ...(becameUnpublished && { published_at: null }),
    type: frontmatter.type ?? existing?.type ?? "blog",
    // `unknown`-valued record → Prisma's InputJsonValue. The values came from
    // gray-matter's YAML parse and were bounds-checked in parsePostFile, so
    // they are already JSON-representable.
    metadata: metadata as Prisma.InputJsonValue,
    featured_image: optionalText(frontmatter.featured_image, existing?.featured_image),
    featured_image_alt: optionalText(frontmatter.featured_image_alt, existing?.featured_image_alt),
    meta_description: optionalText(frontmatter.meta_description, existing?.meta_description),
    meta_keywords: optionalText(frontmatter.meta_keywords, existing?.meta_keywords),
    seo_title: optionalText(frontmatter.seo_title, existing?.seo_title),
    canonical_url: optionalText(frontmatter.canonical_url, existing?.canonical_url),
    og_image: optionalText(frontmatter.og_image, existing?.og_image),
    og_image_alt: optionalText(frontmatter.og_image_alt, existing?.og_image_alt),
    noindex: frontmatter.noindex ?? existing?.noindex ?? false,
    answer_summary: optionalText(frontmatter.answer_summary, existing?.answer_summary),
    redirect_to: optionalText(frontmatter.redirect_to, existing?.redirect_to),
    tags: frontmatter.tags ?? existing?.tags ?? [],
    platforms: targetPlatforms,
    category_id: categoryId,
    reading_time: contentHtml ? readingTime(contentHtml) : null,
    ...(!existing && { author_name: authorDisplayName(actor.user), author_id: actor.user.id }),
  };

  // Snapshot the OUTGOING content before an ingest overwrites it — the same
  // pre-write rule as the CMS PUT route (see src/lib/post-revisions.ts),
  // gated on the incoming write actually changing a snapshotted field so a
  // metadata-only re-sync doesn't spam the History panel.
  const snapshotOutgoing = opts.revision?.snapshot !== false && contentChanged;

  // Retiring a slug (G#31), same upsert rule as the CMS PUT route — see the
  // doc comment on the transaction below and on PostSlugHistory itself.
  const slugChanged = !!existing && slug !== existing.slug;

  const includeCategory = { include: { category: { select: { id: true, name: true, slug: true } } } };
  // Two round-trips (the `existing` read above, this write) — undefined
  // means no CAS is requested (force, or the frontmatter carried no hash at
  // all), in which case a plain unique-id update() is atomic and race-free
  // on its own and returns the row exactly as the database now has it. WITH
  // a hash, condition the write itself on content_hash (not just the earlier
  // read) so a concurrent import/webhook racing in between can't both pass
  // the check above and one silently clobber the other — mirroring the PUT
  // route's updateMany guard, whose response is likewise built from the data
  // just written rather than a second, independent findUnique.
  const expectedContentHash =
    existing && frontmatter.content_hash !== undefined && !force ? frontmatter.content_hash : undefined;

  let post;
  let raced = false;
  try {
    if (existing && (snapshotOutgoing || slugChanged)) {
      // A transaction is only needed to pair the write with its revision
      // snapshot / slug-history row atomically — a plain single-statement
      // write (the branch below, for a metadata-only re-sync) needs no
      // transaction wrapper.
      await db.$transaction(async (tx) => {
        if (expectedContentHash === undefined) {
          post = await tx.post.update({ where: { id: existing.id }, data, ...includeCategory });
        } else {
          const updateResult = await tx.post.updateMany({
            where: { id: existing.id, content_hash: expectedContentHash },
            data,
          });
          if (updateResult.count === 0) {
            raced = true;
            return;
          }
        }
        if (snapshotOutgoing) {
          await tx.postRevision.create({
            data: revisionSnapshotData(existing.id, existing, actor.user.id, opts.revision?.source ?? "import"),
          });
        }
        if (slugChanged) {
          await tx.postSlugHistory.upsert({
            where: {
              organization_id_old_slug: {
                organization_id: existing.organization_id,
                old_slug: existing.slug,
              },
            },
            create: {
              organization_id: existing.organization_id,
              post_id: existing.id,
              old_slug: existing.slug,
            },
            update: { post_id: existing.id },
          });
        }
      });
      if (!raced && snapshotOutgoing) void pruneOldRevisions(db, existing.id).catch(() => {});
    } else if (existing) {
      if (expectedContentHash === undefined) {
        post = await db.post.update({ where: { id: existing.id }, data, ...includeCategory });
      } else {
        const updateResult = await db.post.updateMany({
          where: { id: existing.id, content_hash: expectedContentHash },
          data,
        });
        if (updateResult.count === 0) raced = true;
      }
    } else {
      post = await db.post.create({ data, ...includeCategory });
    }
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { kind: "error", status: 409, message: `A post with slug "${slug}" already exists` };
    }
    throw e;
  }

  if (raced) {
    const current =
      onConflict === "flag"
        ? await db.post
            .update({ where: { id: existing!.id }, data: { sync_conflict: true } })
            .catch((e) => {
              if (isRecordNotFound(e)) return null;
              throw e;
            })
        : await db.post.findUnique({ where: { id: existing!.id } });
    if (!current) return { kind: "error", status: 404, message: `Post ${existing!.id} not found` };
    return {
      kind: "conflict",
      currentHash: current.content_hash,
      conflict: postConflictBody(current),
      ...(onConflict === "flag" && { flagged: true }),
    };
  }
  if (existing && !post) {
    // Build the response from what THIS request just wrote, not a second,
    // independent findUnique — a write landing in the gap between commit and
    // that re-read would otherwise get silently adopted as a caller's next
    // baseline (e.g. re-exporting this post per D3), reopening the race this
    // path exists to close.
    const category = data.category_id
      ? await db.category.findUnique({ where: { id: data.category_id }, select: { id: true, name: true, slug: true } })
      : null;
    post = { ...existing, ...data, updated_at: new Date(), category };
  }
  if (!post) return { kind: "error", status: 404, message: `Post ${existing?.id ?? ""} not found` };

  // Fire-and-forget IndexNow (SEO-AEO-GEO-PLAN.md Layer D) — this path is
  // shared by the HTTP import route AND the inbound GitHub webhook, so
  // hooking it here covers both without duplicating the trigger logic the
  // CMS PUT route also has. Same rule: a slug change pings both URLs;
  // otherwise only a publish/unpublish transition or a substantive content
  // change is worth a ping — and only once the post is actually published:
  // a draft's URL was never indexed, so a pure content-change ping on it
  // would tell Bing to recheck a page that 404s.
  const contentPingWorthy = status === "published" && contentChanged;
  if (slugChanged) {
    // The retired slug lived under whatever platforms hosted it BEFORE this
    // write, not `data.platforms` (the possibly-changed target set it's
    // being saved with now) — see the identical fix in the CMS PUT route
    // (src/app/api/cms/posts/[id]/route.ts) for why using the new set for
    // the OLD slug's ping is wrong on both ends.
    void notifyIndexNowForPost(db, { platforms: existing!.platforms }, [existing!.slug]);
    void notifyIndexNowForPost(db, { platforms: data.platforms }, [slug]);
  } else if (becamePublished || becameUnpublished || contentPingWorthy) {
    void notifyIndexNowForPost(db, { platforms: data.platforms }, [slug]);
  }

  return { kind: "applied", post: formatPost(post), created: !existing, warning };
}

/**
 * An optional text column from a file: absent keeps the post's current value,
 * and an explicitly empty one clears it to null (it used to store "", which
 * every consumer then had to treat as "no image" / "no description").
 */
export function optionalText(value: string | undefined, current: string | null | undefined): string | null {
  if (value === undefined) return current ?? null;
  return value.trim() ? value : null;
}
