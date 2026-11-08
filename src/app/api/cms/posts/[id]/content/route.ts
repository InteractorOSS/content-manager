import { NextRequest, NextResponse } from "next/server";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, editPostRefusalMessage, authorDisplayName } from "@/lib/rbac";
import { sanitizePostContent } from "@/lib/sanitize";
import { computeContentHash, computeContentHtml } from "@/lib/markdown";
import { stripHtml } from "@/lib/utils";
import {
  pruneOldRevisions,
  resolveRevisionSource,
  revisionSnapshotData,
} from "@/lib/post-revisions";
import { postConflictBody, resolveExpectedContentHash } from "@/lib/post-conflict";
import { previewUrlForActor, omitPreviewToken } from "@/lib/preview-link";
import type { Actor } from "@/lib/rbac";
import { applyAnchoredReplacements, type AnchoredReplacement } from "@/lib/post-anchored-edit";
import { notifyIndexNowForPost } from "@/lib/indexnow";

function readingTime(content: string): number {
  const words = stripHtml(content).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

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

/**
 * PATCH a post's content by exact-match find/replace instead of re-sending
 * the whole body (G#15). Every replacement in `replacements` must match its
 * `find` anchor exactly `expected_occurrences` times (default 1); a
 * zero-match or ambiguous anchor refuses the WHOLE call with a 400 naming
 * which replacement failed and why — the post is never partially edited.
 * Shares the optimistic-concurrency guard (G-C) and revision capture (G-A)
 * with PUT /api/cms/posts/[id], and re-runs the same write pipeline
 * (sanitize, content_html, content_hash, reading_time) so this never becomes
 * a second, weaker path into the post table.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { actor, db, via, error, apiToken } = await requirePermissionApi(req, "content:edit");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { replacements?: unknown; expected_content_hash?: unknown }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const rawReplacements = body.replacements;
  if (!Array.isArray(rawReplacements) || rawReplacements.length === 0) {
    return NextResponse.json({ error: "replacements must be a non-empty array" }, { status: 400 });
  }

  const replacements: AnchoredReplacement[] = [];
  for (let i = 0; i < rawReplacements.length; i++) {
    const r = rawReplacements[i] as Record<string, unknown>;
    if (typeof r?.find !== "string" || r.find.length === 0 || typeof r?.replace !== "string") {
      return NextResponse.json(
        { error: `Replacement ${i}: "find" must be a non-empty string and "replace" must be a string` },
        { status: 400 }
      );
    }
    let expectedOccurrences: number | undefined;
    if (r.expected_occurrences !== undefined) {
      if (!Number.isInteger(r.expected_occurrences) || (r.expected_occurrences as number) < 1) {
        return NextResponse.json(
          { error: `Replacement ${i}: "expected_occurrences" must be a positive integer` },
          { status: 400 }
        );
      }
      expectedOccurrences = r.expected_occurrences as number;
    }
    replacements.push({ find: r.find, replace: r.replace, expected_occurrences: expectedOccurrences });
  }

  const existing = await db.post.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, existing.platforms, "change");
  if (outOfScope) return outOfScope;

  if (!canEditPost(actor, existing)) {
    return NextResponse.json({ error: editPostRefusalMessage(existing) }, { status: 403 });
  }

  // Same optimistic-concurrency contract as PUT (G-C): absent
  // expected_content_hash skips the check; present-and-stale is a 409.
  const expectedContentHash = resolveExpectedContentHash(body, req.headers.get("if-match"));
  if (expectedContentHash !== undefined && expectedContentHash !== existing.content_hash) {
    return NextResponse.json(postConflictBody(existing), { status: 409 });
  }

  const replaceResult = applyAnchoredReplacements(existing.content ?? "", replacements);
  if (!replaceResult.ok) {
    const { index, find, expected_occurrences, found_occurrences } = replaceResult.failure;
    return NextResponse.json(
      {
        error:
          `Replacement ${index} found ${found_occurrences} match(es) for its anchor, ` +
          `expected ${expected_occurrences} — no changes were applied`,
        index,
        find,
        expected_occurrences,
        found_occurrences,
      },
      { status: 400 }
    );
  }

  // content_format is not itself editable here — sanitize on write only for
  // html (rendered as-is); markdown is stored verbatim, same as PUT.
  const rawContent = replaceResult.content;
  const content =
    existing.content_format === "markdown" ? rawContent : sanitizePostContent(rawContent);

  // A successful replacement (every anchor matched) does not guarantee the
  // FINAL content actually differs from what's stored: find===replace is a
  // valid no-op call, and for html-format posts sanitizePostContent() can
  // strip a replacement's diff back to byte-identical (e.g. an injected tag
  // sanitization removes entirely). Comparing here — rather than assuming
  // success implies change — is what PUT gets from postContentChanged();
  // this route only ever touches content, so "unchanged" means nothing at
  // all should be written: no DB write, no revision, no reattributed
  // updated_by/updated_at for a call that had no real effect.
  if (content === (existing.content ?? "")) {
    return NextResponse.json({ data: formatPost(existing, actor) });
  }

  const contentHtml = content ? computeContentHtml(content, existing.content_format) : null;

  // A published post must never end up with no content through any write
  // path — mirrors the same check on PUT.
  if (existing.status === "published" && !stripHtml(contentHtml ?? "").trim()) {
    return NextResponse.json(
      { error: "Content is required to publish a post" },
      { status: 400 }
    );
  }

  const updateData = {
    content: content || null,
    content_html: contentHtml,
    content_hash: content ? computeContentHash(content) : null,
    reading_time: contentHtml ? readingTime(contentHtml) : null,
    updated_by_id: actor.user.id,
    updated_by_name: authorDisplayName(actor.user),
    // Honest "Updated <date>" (G#31) + sitemap lastmod (G#34, feed.ts): the
    // no-op check above already guarantees reaching here means content
    // genuinely changed, so unlike PUT (which gates this on
    // postContentChanged() across several possibly-untouched fields) this
    // route can bump it unconditionally.
    content_updated_at: new Date(),
  };

  // The findUnique above and this write are two round-trips — condition the
  // write itself on content_hash (not just the earlier read) so a second
  // request racing in between can't both pass the check and one silently
  // clobber the other, same as PUT.
  const updateWhere = expectedContentHash !== undefined ? { id, content_hash: expectedContentHash } : { id };
  const includeCategory = { include: { category: { select: { id: true, name: true, slug: true } } } };

  // Reaching here means content genuinely changed (the no-op check above
  // returned early otherwise), so — unlike PUT, which gates on
  // postContentChanged() because most of its fields aren't content — the
  // revision snapshot and the write always pair atomically from this point.
  let raced = false;
  let post: Record<string, unknown> | null = null;
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
    await tx.postRevision.create({
      data: revisionSnapshotData(id, existing, actor.user.id, resolveRevisionSource(req, via)),
    });
  });

  if (raced) {
    const current = await db.post.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(postConflictBody(current), { status: 409 });
  }

  void pruneOldRevisions(db, id).catch(() => {});

  if (!post) {
    // The CAS (updateMany) path: build the response from what THIS request
    // just wrote, not a second, independent findUnique — see PUT for why.
    // category_id is never touched by this route, so `existing`'s own value
    // is still current; only the relation needs a lookup.
    const category = existing.category_id
      ? await db.category.findUnique({
          where: { id: existing.category_id },
          select: { id: true, name: true, slug: true },
        })
      : null;
    post = { ...existing, ...updateData, updated_at: new Date(), category };
  }
  // Fire-and-forget IndexNow (SEO-AEO-GEO-PLAN.md Layer D) — same rule as
  // PUT's substantive-content-change ping: only worth telling Bing about
  // when the post is actually live. This route never touches `status`, so
  // `existing.status` is still the post's current status.
  if (existing.status === "published") {
    void notifyIndexNowForPost(db, existing, [existing.slug]);
  }
  return NextResponse.json({ data: formatPost(post, actor) });
}
