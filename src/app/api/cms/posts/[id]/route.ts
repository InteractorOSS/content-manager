import { NextRequest, NextResponse } from "next/server";
import { trashPosts } from "@/lib/post-trash";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage, resolveAuthorOverride, authorDisplayName } from "@/lib/rbac";
import { sanitizePostContent } from "@/lib/sanitize";
import { computeContentHash, computeContentHtml } from "@/lib/markdown";
import { stripHtml } from "@/lib/utils";
import { parseSiteSlugs } from "@/lib/sites";
import { orgSiteSlugs } from "@/lib/sites-server";
import {
  postContentChanged,
  pruneOldRevisions,
  resolveRevisionSource,
  revisionSnapshotData,
} from "@/lib/post-revisions";
import { previewUrlForActor, omitPreviewToken } from "@/lib/preview-link";
import type { Actor } from "@/lib/rbac";
import { postConflictBody, resolveExpectedContentHash } from "@/lib/post-conflict";
import { generateFeaturedImageOrNull } from "@/lib/featured-image";
import { notifyIndexNowForPost } from "@/lib/indexnow";
import { syncPostSocialDelivery } from "@/lib/post-social-delivery";

function readingTime(content: string): number {
  const words = stripHtml(content).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// preview_url is a bypass credential (opens the post with no CMS session),
// so — unlike every other field here — it is NOT safe to include for any
// content:view holder; previewUrlForActor gates it the same way minting/
// revoking the link is gated (canEditPost), never unconditionally.
function formatPost(post: any, actor: Actor) {
  return {
    ...omitPreviewToken(post),
    inserted_at: post.inserted_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
    published_at: post.published_at?.toISOString() ?? null,
    preview_url: previewUrlForActor(actor, post),
  };
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({
    where: { id },
    include: { category: { select: { id: true, name: true, slug: true } } },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "read");
  if (outOfScope) return outOfScope;

  return NextResponse.json({ data: formatPost(post, actor) });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { actor, db, via, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const body = await req.json() as { post?: Record<string, unknown> };
  const data: Record<string, unknown> = body.post ?? body;

  const existing = await db.post.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A site-scoped token (G#21) may only change a post whose CURRENT sites are
  // all in scope; new `platforms` are checked against it too, further down.
  const outOfScope = siteScopeRefusal(apiToken, existing.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, existing)) {
    return NextResponse.json(
      { error: editPostRefusalMessage(existing) },
      { status: 403 }
    );
  }

  // Optimistic concurrency: absent expected_content_hash preserves today's
  // behavior for callers that haven't adopted it yet. When present (including
  // explicit null, meaning "I loaded a post with no content_hash yet"), a
  // value that no longer matches means someone else wrote this post since the
  // caller loaded it — refuse rather than silently clobbering their edit (see
  // post-sync.ts, which already applies this rule on the git-import path).
  const expectedContentHash = resolveExpectedContentHash(data, req.headers.get("if-match"));
  if (expectedContentHash !== undefined && expectedContentHash !== existing.content_hash) {
    return NextResponse.json(postConflictBody(existing), { status: 409 });
  }

  // Reassigning authorship (author_id, or an author_name that diverges from
  // the post's current one) is a content:edit_any action — see
  // resolveAuthorOverride() for the shared create/update rules.
  const authorOutcome = await resolveAuthorOverride(db, actor, data, {
    author_id: existing.author_id,
    author_name: existing.author_name,
  });
  if (!authorOutcome.ok) {
    return NextResponse.json({ error: authorOutcome.error }, { status: authorOutcome.status });
  }
  const authorNameTouched = authorOutcome.authorNameTouched;
  const resolvedAuthorId = authorOutcome.authorId;
  const resolvedAuthorName = authorOutcome.authorName;

  // Status transitions to/from published are gated on content:publish;
  // without it the status field is left untouched.
  if (
    data.status !== undefined &&
    data.status !== existing.status &&
    (data.status === "published" || existing.status === "published") &&
    !actor.permissions.has("content:publish")
  ) {
    delete data.status;
  }

  // Markdown is stored verbatim (never dangerouslySetInnerHTML'd directly —
  // content_html below is the sanitized render); HTML is sanitized at write
  // time as before, since it's rendered as-is.
  const resolvedContentFormat =
    data.content_format !== undefined ? String(data.content_format) : existing.content_format;
  if (data.content !== undefined) {
    data.content =
      resolvedContentFormat === "markdown"
        ? String(data.content)
        : sanitizePostContent(String(data.content));
  }
  const content = data.content !== undefined ? String(data.content) : existing.content ?? "";

  // Recompute content_html whenever the content or its format changes —
  // this is the value publish-emptiness/reading-time checks read below, and
  // what the public API serves alongside raw `content` (see D2).
  const contentHtml =
    data.content !== undefined || data.content_format !== undefined
      ? content
        ? computeContentHtml(content, resolvedContentFormat)
        : null
      : undefined;
  const effectiveContentHtml = contentHtml !== undefined ? contentHtml : existing.content_html;

  // Continuous learning (Phase D): the editor only sends this when the save
  // still matches an applied AI revision exactly (see post-editor.tsx) — it
  // stamps the baseline the workflow route diffs against on approve/publish.
  const aiSnapshot = data.ai_snapshot as { profile_id?: string; content?: string } | undefined;

  // Sites: absent → untouched; sent but nothing valid → reject rather than
  // leave the post invisible on every site. The post's CURRENT slugs are
  // allowed alongside the org's registered ones (G#18) so that re-saving a
  // post carrying an unregistered slug — imported from a file, or left from a
  // site since removed — doesn't silently narrow its distribution.
  const platforms = parseSiteSlugs(
    data.platforms,
    await orgSiteSlugs(db, existing.platforms)
  );
  if (platforms !== null && platforms.length === 0) {
    return NextResponse.json(
      { error: "At least one valid site is required" },
      { status: 400 }
    );
  }

  // ...and the sites a site-scoped token retargets the post to must be in its
  // scope as well (the current ones were checked above).
  if (platforms !== null) {
    const retargetOutOfScope = siteScopeRefusal(apiToken, platforms, "target");
    if (retargetOutOfScope) return retargetOutOfScope;
  }

  const wasPublished = existing.status !== "published" && data.status === "published";
  const wasUnpublished = existing.status === "published" && data.status && data.status !== "published";

  // The website's mirror requires non-empty content on every published post
  // (Interactor.Content.Post.changeset); a post reaching/staying "published"
  // with empty content here would fail to sync and log warnings forever.
  // Check stripped text off the rendered HTML, not raw content truthiness —
  // a cleared contenteditable div normalizes to "<p><br></p>", which is
  // non-empty HTML but no content, and this also works uniformly for
  // markdown source via its rendered content_html.
  const resultingStatus = data.status !== undefined ? String(data.status) : existing.status;
  if (resultingStatus === "published" && !stripHtml(effectiveContentHtml ?? "").trim()) {
    return NextResponse.json(
      { error: "Content is required to publish a post" },
      { status: 400 }
    );
  }

  // Same rule as content above: a post can't stay (or become) published
  // without a featured image — so generate a title card for it (free,
  // src/lib/featured-image.tsx) and refuse only if that fails.
  const resultingFeaturedImage =
    data.featured_image !== undefined ? String(data.featured_image) || null : existing.featured_image;
  let generatedImage: { featured_image: string; featured_image_alt?: string } | null = null;
  if (resultingStatus === "published" && !resultingFeaturedImage) {
    const generated = await generateFeaturedImageOrNull(db, actor, {
      title: data.title !== undefined ? String(data.title) : existing.title,
      slug: data.slug !== undefined ? String(data.slug) : existing.slug,
      category_id:
        data.category_id !== undefined ? String(data.category_id) || null : existing.category_id,
      author_name: authorNameTouched ? resolvedAuthorName : existing.author_name,
    });
    if (!generated) {
      return NextResponse.json(
        { error: "An image is required to publish a post" },
        { status: 400 }
      );
    }
    const resultingAlt =
      data.featured_image_alt !== undefined
        ? String(data.featured_image_alt) || null
        : existing.featured_image_alt;
    generatedImage = {
      featured_image: generated.url,
      ...(!resultingAlt && { featured_image_alt: generated.alt }),
    };
  }

  const updateData = {
    updated_by_id: actor.user.id,
    updated_by_name: authorDisplayName(actor.user),
    ...(data.title !== undefined && { title: String(data.title) }),
    ...(data.slug !== undefined && { slug: String(data.slug) }),
    ...(data.content !== undefined && { content: String(data.content) || null }),
    ...(contentHtml !== undefined && { content_html: contentHtml }),
    ...(data.content !== undefined && { content_hash: content ? computeContentHash(content) : null }),
    ...(data.excerpt !== undefined && { excerpt: String(data.excerpt) || null }),
    ...(data.status !== undefined && { status: String(data.status) }),
    ...(data.type !== undefined && { type: String(data.type) }),
    ...(data.content_format !== undefined && { content_format: String(data.content_format) }),
    ...(data.content_styles !== undefined && { content_styles: String(data.content_styles) || null }),
    ...(data.featured_image !== undefined && { featured_image: String(data.featured_image) || null }),
    ...(data.featured_image_alt !== undefined && { featured_image_alt: String(data.featured_image_alt) || null }),
    ...generatedImage,
    ...(data.meta_description !== undefined && { meta_description: String(data.meta_description) || null }),
    ...(data.meta_keywords !== undefined && { meta_keywords: String(data.meta_keywords) || null }),
    ...(data.seo_title !== undefined && { seo_title: String(data.seo_title) || null }),
    ...(data.canonical_url !== undefined && { canonical_url: String(data.canonical_url) || null }),
    ...(data.og_image !== undefined && { og_image: String(data.og_image) || null }),
    ...(data.og_image_alt !== undefined && { og_image_alt: String(data.og_image_alt) || null }),
    ...(data.noindex !== undefined && { noindex: data.noindex === true }),
    ...(data.answer_summary !== undefined && { answer_summary: String(data.answer_summary) || null }),
    ...(data.redirect_to !== undefined && { redirect_to: String(data.redirect_to) || null }),
    // Honest "Updated <date>" (G#31): bumps only when postContentChanged says
    // this edit actually touched title/content/content_format/excerpt, or the
    // caller explicitly says so via mark_updated — the escape hatch for a
    // substantive change that function can't see (e.g. a corrected figure
    // inside otherwise-unchanged prose). A pure metadata/tag/status edit
    // leaves it untouched, same gate as the revision snapshot below.
    ...((postContentChanged(data, existing) || data.mark_updated === true) && {
      content_updated_at: new Date(),
    }),
    ...(authorNameTouched && { author_name: resolvedAuthorName }),
    ...(resolvedAuthorId !== undefined && { author_id: resolvedAuthorId }),
    ...(data.category_id !== undefined && { category_id: String(data.category_id) || null }),
    ...(Array.isArray(data.tags) && { tags: data.tags as string[] }),
    ...(platforms !== null && { platforms }),
    ...(contentHtml !== undefined && { reading_time: contentHtml ? readingTime(contentHtml) : null }),
    ...(wasPublished ? { published_at: new Date() } : wasUnpublished ? { published_at: null } : {}),
    ...(aiSnapshot?.profile_id && aiSnapshot.content !== undefined && {
      ai_style_profile_id: aiSnapshot.profile_id,
      ai_generated_content: aiSnapshot.content,
      ai_generated_at: new Date(),
    }),
  };

  // Snapshot the OUTGOING content BEFORE it's overwritten — revision history
  // records past versions; the current version lives on the row. Gated on an
  // actual content-field change so a pure status/tag/metadata edit doesn't
  // spam the History panel (mirrors the FaqRevision `answerChanged` gate).
  const snapshotOnChange = postContentChanged(data, existing);

  // Retiring a slug (G#31): the OUTGOING slug, before it's overwritten, so a
  // stale link to it can be answered with a redirect instead of a 404 — see
  // resolvePostBySlugOrHistory in src/lib/public-post.ts. Upserted rather than
  // created outright: if this exact (org, old_slug) pair was already retired
  // by an earlier rename — including a different post's, once a slug is freed
  // and reused — the most recent retirement is the one a redirect should
  // honour, so the existing row is repointed at this post rather than left
  // stale or duplicated (old_slug is unique per org either way).
  const slugChanged = data.slug !== undefined && String(data.slug) !== existing.slug;

  // The findUnique above and this write are two round-trips, not one — condition
  // the write itself on content_hash (not just the earlier read) so a second
  // request racing in between can't both pass the check and one silently clobber
  // the other. count === 0 means content_hash changed since we read `existing`;
  // re-fetch for the real current state rather than trusting our stale copy.
  const updateWhere = expectedContentHash !== undefined ? { id, content_hash: expectedContentHash } : { id };

  const includeCategory = { include: { category: { select: { id: true, name: true, slug: true } } } };

  // No expected_content_hash means no CAS is needed, so use a plain
  // unique-id update() — atomic and race-free on its own, and it returns the
  // row exactly as the database now has it. WITH a hash, Prisma has no typed
  // `where` for "id AND content_hash" (content_hash isn't a unique field), so
  // updateMany is the only way to condition the write — its response must
  // then be built from the data just written (see below) rather than a
  // second read, which would reopen the same race one layer up.
  let raced = false;
  let post: Record<string, unknown> | null = null;
  try {
    if (snapshotOnChange || slugChanged) {
      // An interactive transaction: the write and its revision snapshot /
      // slug-history row commit or roll back together, so neither a
      // revision-create nor a slug-retirement failure ever leaves the content
      // change committed with no corresponding history entry. Only needed
      // when there's a second statement to pair atomically with the write —
      // a plain single-statement write below needs no transaction wrapper.
      await db.$transaction(async (tx) => {
        if (expectedContentHash === undefined) {
          post = await tx.post.update({ where: { id }, data: updateData, ...includeCategory });
        } else {
          const updateResult = await tx.post.updateMany({ where: updateWhere, data: updateData });
          if (updateResult.count === 0) {
            raced = true;
            return;
          }
        }
        if (snapshotOnChange) {
          await tx.postRevision.create({
            data: revisionSnapshotData(id, existing, actor.user.id, resolveRevisionSource(req, via)),
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
              post_id: id,
              old_slug: existing.slug,
            },
            update: { post_id: id },
          });
        }
      });
    } else if (expectedContentHash === undefined) {
      post = await db.post.update({ where: { id }, data: updateData, ...includeCategory });
    } else {
      const updateResult = await db.post.updateMany({ where: updateWhere, data: updateData });
      if (updateResult.count === 0) raced = true;
    }
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: "A post with this slug already exists" },
        { status: 409 }
      );
    }
    throw e;
  }

  if (raced) {
    const current = await db.post.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(postConflictBody(current), { status: 409 });
  }

  if (snapshotOnChange) void pruneOldRevisions(db, id).catch(() => {});

  if (!post) {
    // The CAS (updateMany) path: build the response from what THIS request
    // just wrote, not a second, independent findUnique issued after the
    // transaction already committed — a write landing in that gap would
    // otherwise get silently adopted as this caller's own baseline for its
    // next save (see post-editor.tsx: onSuccess does
    // setContentHash(saved.content_hash)).
    const finalCategoryId = (updateData.category_id !== undefined ? updateData.category_id : existing.category_id) as
      | string
      | null;
    const category = finalCategoryId
      ? await db.category.findUnique({ where: { id: finalCategoryId }, select: { id: true, name: true, slug: true } })
      : null;
    post = { ...existing, ...updateData, updated_at: new Date(), category };
  }

  // Fire-and-forget IndexNow (SEO-AEO-GEO-PLAN.md Layer D) — never awaited,
  // never allowed to slow down or fail this response. A slug change pings
  // BOTH the retired URL and the new one; otherwise only a substantive
  // content change, or a publish/unpublish transition, is worth telling
  // Bing about — a pure tag/status-unrelated metadata save is not.
  const finalSlug = data.slug !== undefined ? String(data.slug) : existing.slug;
  const finalPlatforms = platforms !== null ? platforms : existing.platforms;
  // A pure content/mark-updated signal is only worth a ping when the post is
  // actually (going to be) published — a draft's URL was never indexed in
  // the first place, so pinging it would tell Bing to recheck a page that
  // 404s. wasPublished/wasUnpublished are unconditional: those pings exist
  // BECAUSE the status just flipped, in either direction.
  const contentPingWorthy =
    resultingStatus === "published" && (snapshotOnChange || data.mark_updated === true);
  if (slugChanged) {
    // The retired slug lived under whatever platforms hosted it BEFORE this
    // save — not the (possibly narrowed/retargeted) `finalPlatforms` it's
    // being saved with now. Pinging the old URL through the new platform
    // set would ask sites that never hosted it to "recheck" a page they
    // never had, while the sites that actually 404 on it now would never
    // hear about it.
    void notifyIndexNowForPost(db, { platforms: existing.platforms }, [existing.slug]);
    void notifyIndexNowForPost(db, { platforms: finalPlatforms }, [finalSlug]);
  } else if (wasPublished || wasUnpublished || contentPingWorthy) {
    void notifyIndexNowForPost(db, { platforms: finalPlatforms }, [finalSlug]);
  }

  // A changed slug, site or canonical URL changes the link the post's social
  // drafts carry back to it. Fire-and-forget, like the pings above, and only
  // when one of those actually moved: an ordinary save has nothing to refresh.
  if (
    post.slug !== existing.slug ||
    post.canonical_url !== existing.canonical_url ||
    finalPlatforms.join("\n") !== existing.platforms.join("\n")
  ) {
    void syncPostSocialDelivery(db, id).catch(() => {});
  }

  return NextResponse.json({ data: formatPost(post, actor) });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:delete");
  if (error) return error;

  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  // To the trash (src/lib/post-trash.ts): restorable for TRASH_RETENTION_DAYS.
  await trashPosts(db, [post], actor);
  // Only a post that was actually LIVE is worth telling IndexNow about — a
  // draft nobody had crawled yet leaves nothing for Bing to re-check.
  if (post.status === "published") {
    void notifyIndexNowForPost(db, post, [post.slug]);
  }
  return new NextResponse(null, { status: 204 });
}
