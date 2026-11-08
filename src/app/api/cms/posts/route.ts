import { NextRequest, NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal, siteScopeWhere } from "@/lib/token-site-scope";
import { resolveAuthorOverride, type PermissionName, authorDisplayName } from "@/lib/rbac";
import { sanitizePostContent } from "@/lib/sanitize";
import { computeContentHash, computeContentHtml } from "@/lib/markdown";
import { stripHtml } from "@/lib/utils";
import { parseSiteSlugs, DEFAULT_SITE_SLUGS } from "@/lib/sites";
import { orgSiteSlugs } from "@/lib/sites-server";
import { previewUrlForActor, omitPreviewToken } from "@/lib/preview-link";
import type { Actor } from "@/lib/rbac";
import { generateFeaturedImageOrNull } from "@/lib/featured-image";
import { notifyIndexNowForPost } from "@/lib/indexnow";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function readingTime(content: string): number {
  const text = stripHtml(content);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");

  // Published posts are readable by any signed-in user (the session gate in
  // proxy.ts already blocks anonymous callers); everything else needs
  // content:view. Either way we resolve the actor's org-scoped `db` so the
  // listing below can't leak another tenant's posts.
  const perms: PermissionName[] = status !== "published" ? ["content:view"] : [];
  const { actor, db, error, apiToken } = await requirePermissionApi(req, ...perms);
  if (error) return error;
  const type = searchParams.get("type");
  const categoryId = searchParams.get("category_id");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const perPage = Math.min(100, parseInt(searchParams.get("per_page") ?? "50"));

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (type) where.type = type;
  if (categoryId) where.category_id = categoryId;
  if (searchParams.get("published") === "true") where.status = "published";
  const workflowStatus = searchParams.get("workflow_status");
  if (workflowStatus) where.workflow_status = workflowStatus;
  // Scheduling: the published view excludes future-dated posts.
  if (where.status === "published") {
    where.OR = [{ published_at: null }, { published_at: { lte: new Date() } }];
  }

  // A site-scoped token (G#21) lists only posts targeting its sites.
  Object.assign(where, siteScopeWhere(apiToken));

  // ?site=<slug> narrows to posts targeting that site, and ?search= matches
  // title, slug, excerpt and body (case-insensitive). Both go in AND so they
  // compose with the site-scope filter and the scheduling OR above rather than
  // overwriting either — they are what lets "the post about X on the website"
  // be one lookup instead of paging through every post in the org.
  const conditions: Record<string, unknown>[] = [];
  const site = searchParams.get("site")?.trim();
  if (site) conditions.push({ platforms: { has: site } });
  const search = searchParams.get("search")?.trim().slice(0, 200);
  if (search) {
    const contains = { contains: search, mode: "insensitive" };
    conditions.push({
      OR: [{ title: contains }, { slug: contains }, { excerpt: contains }, { content: contains }],
    });
  }
  if (conditions.length > 0) where.AND = conditions;

  const [posts, total] = await db.$transaction([
    db.post.findMany({
      where,
      include: { category: { select: { id: true, name: true, slug: true } } },
      orderBy: { updated_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.post.count({ where }),
  ]);

  return NextResponse.json({
    data: posts.map((p) => formatPost(p, actor)),
    meta: { total, page, per_page: perPage },
  });
}

export async function POST(req: NextRequest) {
  const { actor, db, error, apiToken } = await requirePermissionApi(req, "content:create");
  if (error) return error;

  const body = await req.json() as { post?: Record<string, unknown> };
  const data: Record<string, unknown> = body.post ?? body;

  const title = String(data.title ?? "");
  const slug = String(data.slug || slugify(title) || `post-${Date.now()}`);
  // Markdown is stored verbatim (never dangerouslySetInnerHTML'd directly —
  // content_html below is the sanitized render); HTML is sanitized at write
  // time as before, since it's rendered as-is.
  const contentFormat = String(data.content_format ?? "markdown");
  const rawContent = String(data.content ?? "");
  const content = contentFormat === "markdown" ? rawContent : sanitizePostContent(rawContent);
  const contentHtml = content ? computeContentHtml(content, contentFormat) : null;

  // Publishing on create requires content:publish; otherwise the post is
  // created as a draft and goes through the review workflow.
  const canPublish = actor.permissions.has("content:publish");
  const publishRequested = data.status === "published";
  const status = publishRequested && canPublish ? "published" : "draft";

  // Authorship defaults to the caller; crediting someone else requires
  // content:edit_any and a real member of this org — see
  // resolveAuthorOverride() for the shared create/update rules. Its "current"
  // is null (not the actor's default name) — there's nothing to clear yet on
  // a brand new post, which is what makes the post editor's always-blank
  // create-form submission a no-op; the actor's default name is passed
  // separately so a caller who (redundantly) names themselves isn't mistaken
  // for an override attempt either.
  const defaultAuthorName = authorDisplayName(actor.user);
  const authorOutcome = await resolveAuthorOverride(
    db,
    actor,
    data,
    { author_id: actor.user.id, author_name: null },
    defaultAuthorName
  );
  if (!authorOutcome.ok) {
    return NextResponse.json({ error: authorOutcome.error }, { status: authorOutcome.status });
  }
  const authorId = authorOutcome.authorId ?? actor.user.id;
  const authorName = authorOutcome.authorName ?? defaultAuthorName;

  // Sites: absent → default; sent but nothing valid → reject rather than
  // create a post no site would ever show. Valid now means "a site THIS org
  // has" (G#18) rather than a name from a global compile-time list.
  const platforms = parseSiteSlugs(data.platforms, await orgSiteSlugs(db));
  if (platforms !== null && platforms.length === 0) {
    return NextResponse.json(
      { error: "At least one valid site is required" },
      { status: 400 }
    );
  }

  // A site-scoped token (G#21) may only create posts for its own sites —
  // refused with the scope named, never quietly retargeted into it.
  const outOfScope = siteScopeRefusal(
    apiToken,
    platforms ?? DEFAULT_SITE_SLUGS,
    "target",
    platforms === null
      ? `Posts target ${DEFAULT_SITE_SLUGS.join(", ")} when platforms is omitted.`
      : undefined
  );
  if (outOfScope) return outOfScope;

  // The website's mirror requires non-empty content on every published post
  // (Interactor.Content.Post.changeset); a post with empty content that
  // reached "published" here would fail to sync and log warnings forever.
  // Check stripped text off the rendered HTML, not raw content truthiness —
  // a cleared contenteditable div normalizes to "<p><br></p>", which is
  // non-empty HTML but no content, and this also works uniformly for
  // markdown source via its rendered content_html.
  if (status === "published" && !stripHtml(contentHtml ?? "").trim()) {
    return NextResponse.json(
      { error: "Content is required to publish a post" },
      { status: 400 }
    );
  }

  // A published post must have a featured image — same rationale as the
  // content check above: nothing downstream can safely fall back to a blank
  // hero image. Rather than refuse, generate a title card (free, rendered on
  // this server — src/lib/featured-image.tsx); refuse only if that fails.
  let featuredImage = data.featured_image ? String(data.featured_image) : null;
  let featuredImageAlt = data.featured_image_alt ? String(data.featured_image_alt) : null;
  if (status === "published" && !featuredImage) {
    const generated = await generateFeaturedImageOrNull(db, actor, {
      title,
      slug,
      category_id: data.category_id ? String(data.category_id) : null,
      author_name: authorName,
    });
    if (!generated) {
      return NextResponse.json(
        { error: "An image is required to publish a post" },
        { status: 400 }
      );
    }
    featuredImage = generated.url;
    featuredImageAlt = featuredImageAlt ?? generated.alt;
  }

  let post;
  try {
    post = await db.post.create({
      data: {
      title,
      slug,
      content: content || null,
      content_html: contentHtml,
      content_hash: content ? computeContentHash(content) : null,
      excerpt: data.excerpt ? String(data.excerpt) : null,
      status,
      workflow_status: status === "published" ? "approved" : "draft",
      approved_at: status === "published" ? new Date() : null,
      approved_by_id: status === "published" ? actor.user.id : null,
      content_format: contentFormat,
      content_styles: data.content_styles ? String(data.content_styles) : null,
      original_filename: data.original_filename ? String(data.original_filename) : null,
      type: String(data.type ?? "blog"),
      featured_image: featuredImage,
      featured_image_alt: featuredImageAlt,
      meta_description: data.meta_description ? String(data.meta_description) : null,
      meta_keywords: data.meta_keywords ? String(data.meta_keywords) : null,
      seo_title: data.seo_title ? String(data.seo_title) : null,
      canonical_url: data.canonical_url ? String(data.canonical_url) : null,
      og_image: data.og_image ? String(data.og_image) : null,
      og_image_alt: data.og_image_alt ? String(data.og_image_alt) : null,
      noindex: data.noindex === true,
      answer_summary: data.answer_summary ? String(data.answer_summary) : null,
      redirect_to: data.redirect_to ? String(data.redirect_to) : null,
      // A brand new post's content has never been more current than right
      // now — no separate "substantive change" gate needed on create, unlike
      // update (see postContentChanged in the PUT handler below).
      content_updated_at: new Date(),
      author_name: authorName,
      author_id: authorId,
      published_at: status === "published" ? new Date() : null,
      reading_time: contentHtml ? readingTime(contentHtml) : null,
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
      platforms: platforms ?? DEFAULT_SITE_SLUGS,
      category_id: data.category_id ? String(data.category_id) : null,
    },
      include: { category: { select: { id: true, name: true, slug: true } } },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: `A post with slug "${slug}" already exists` },
        { status: 409 }
      );
    }
    throw e;
  }

  // A post created directly as "published" is exactly as newsworthy to
  // IndexNow as one published via the workflow route — fire-and-forget, same
  // as every other trigger point (SEO-AEO-GEO-PLAN.md Layer D).
  if (status === "published") {
    void notifyIndexNowForPost(db, post, [post.slug]);
  }

  const response: Record<string, unknown> = { data: formatPost(post, actor) };
  if (publishRequested && !canPublish) {
    response.warning = "You lack content:publish — the post was saved as a draft; submit it for review.";
  }
  return NextResponse.json(response, { status: 201 });
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
