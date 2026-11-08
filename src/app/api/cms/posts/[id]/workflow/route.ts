import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermissionApi } from "@/lib/guard";
import { siteScopeRefusal } from "@/lib/token-site-scope";
import { canEditPost, type Actor } from "@/lib/rbac";
import { aiConfigured } from "@/lib/ai/client";
import { proposeGuideAmendment } from "@/lib/ai/style";
import { stripHtml } from "@/lib/utils";
import { previewUrlForActor, omitPreviewToken } from "@/lib/preview-link";
import { generateFeaturedImageOrNull } from "@/lib/featured-image";
import { checkPostReadiness } from "@/lib/seo-readiness";
import { notifyIndexNowForPost } from "@/lib/indexnow";
import { syncPostSocialDelivery } from "@/lib/post-social-delivery";
import { HUMANIZER_VERSION } from "@/lib/humanizer";
import { findHumanizerTells } from "@/lib/humanizer/tells";
import { reviewWithHumanizer, reviewWarnings } from "@/lib/humanizer/review";

type Ctx = { params: Promise<{ id: string }> };

type Action = "submit" | "approve" | "reject" | "publish" | "unpublish";

// Continuous learning (Phase D, CONTENT-AI-PLAN.md §4 point 5): the moment a
// post with AI provenance becomes final, diff what was generated against
// what the author kept and propose a guide amendment if the edits reveal a
// durable preference. Best-effort — never blocks or fails the workflow
// transition; the baseline is cleared once checked either way so a later
// re-publish of the same post doesn't re-propose the same diff.
async function maybeProposeAmendment(post: {
  id: string;
  ai_style_profile_id: string | null;
  ai_generated_content: string | null;
  content: string | null;
}) {
  if (!post.ai_style_profile_id || !post.ai_generated_content) return;
  if (post.ai_generated_content === (post.content ?? "")) {
    await prisma.post.update({
      where: { id: post.id },
      data: { ai_generated_content: null },
    });
    return;
  }
  if (!aiConfigured()) return;

  try {
    const latestGuide = await prisma.styleGuideVersion.findFirst({
      where: { profile_id: post.ai_style_profile_id },
      orderBy: { version: "desc" },
    });
    if (!latestGuide) return;

    const { proposal } = await proposeGuideAmendment(
      latestGuide.guide,
      post.ai_generated_content,
      post.content ?? ""
    );

    if (proposal.has_suggestion) {
      await prisma.guideAmendmentSuggestion.create({
        data: {
          profile_id: post.ai_style_profile_id,
          post_id: post.id,
          diff_summary: proposal.diff_summary,
          rationale: proposal.rationale,
          suggested_guide: proposal.amended_guide,
        },
      });
    }
    await prisma.post.update({
      where: { id: post.id },
      data: { ai_generated_content: null },
    });
  } catch (e) {
    console.error("Continuous learning: failed to diff post", post.id, e);
  }
}

// Workflow mirrors the Phoenix CMS: draft → pending_review → approved/rejected,
// with content:publish holders able to publish directly.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { actor, db, error, apiToken, via } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: Action;
    comments?: string;
    reason?: string;
  };
  const action = body.action;

  const post = await db.post.findUnique({ where: { id } });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const outOfScope = siteScopeRefusal(apiToken, post.platforms, "change");
  if (outOfScope) return outOfScope;

  const forbidden = (message: string) =>
    NextResponse.json({ error: message }, { status: 403 });
  const conflict = (message: string) =>
    NextResponse.json({ error: message }, { status: 409 });
  // Search & AI readiness gate (G#32): shared by "approve" and "publish",
  // the only two transitions it blocks. An already-published post that
  // predates the check is never retro-blocked, since this only runs when a
  // post is about to move.
  const readinessRefusal = () => {
    const errors = checkPostReadiness(post).errors;
    return errors.length > 0
      ? NextResponse.json({ error: "Search & AI readiness check failed", findings: errors }, { status: 400 })
      : null;
  };

  // Humanizer check for token callers (MCP, the Claude connector, the plugin,
  // REST): the CMS only ASKED those clients to write like a person, so on
  // submit and publish it looks for itself and says what it found, in the
  // response. Advisory, never a refusal. The model half is cached, so after a
  // check_post_seo it costs nothing. Browser sessions are left alone: the
  // editor's readiness panel shows the same findings without slowing Publish.
  const humanizerReport = async () => {
    if (via !== "token") return {};
    const review = await reviewWithHumanizer(post);
    return {
      humanizer: {
        version: HUMANIZER_VERSION,
        reviewed: review !== null,
        warnings: [...findHumanizerTells(post), ...reviewWarnings(review)],
      },
    };
  };

  switch (action) {
    case "submit": {
      if (!canEditPost(actor, post)) {
        return forbidden("You can only submit your own posts for review");
      }
      if (!["draft", "rejected"].includes(post.workflow_status)) {
        return conflict(`Cannot submit a post in '${post.workflow_status}' state`);
      }
      const updated = await db.post.update({
        where: { id },
        data: { workflow_status: "pending_review", rejection_reason: null },
      });
      return NextResponse.json({ data: format(updated, actor), ...(await humanizerReport()) });
    }

    case "approve": {
      if (!actor.permissions.has("content:approve")) {
        return forbidden("Missing content:approve permission");
      }
      if (post.workflow_status !== "pending_review") {
        return conflict(`Cannot approve a post in '${post.workflow_status}' state`);
      }
      const readinessError = readinessRefusal();
      if (readinessError) return readinessError;
      const [updated] = await db.$transaction([
        db.post.update({
          where: { id },
          data: {
            workflow_status: "approved",
            approved_at: new Date(),
            approved_by_id: actor.user.id,
            rejection_reason: null,
          },
        }),
        db.contentApproval.create({
          data: {
            post_id: id,
            reviewer_id: actor.user.id,
            action: "approved",
            comments: body.comments ?? null,
          },
        }),
      ]);
      await maybeProposeAmendment(updated);
      return NextResponse.json({ data: format(updated, actor) });
    }

    case "reject": {
      if (!actor.permissions.has("content:reject")) {
        return forbidden("Missing content:reject permission");
      }
      if (post.workflow_status !== "pending_review") {
        return conflict(`Cannot reject a post in '${post.workflow_status}' state`);
      }
      const reason = body.reason || body.comments || null;
      const [updated] = await db.$transaction([
        db.post.update({
          where: { id },
          data: { workflow_status: "rejected", rejection_reason: reason },
        }),
        db.contentApproval.create({
          data: {
            post_id: id,
            reviewer_id: actor.user.id,
            action: "rejected",
            comments: reason,
          },
        }),
      ]);
      return NextResponse.json({ data: format(updated, actor) });
    }

    case "publish": {
      if (!actor.permissions.has("content:publish")) {
        return forbidden("Missing content:publish permission");
      }
      const readinessError = readinessRefusal();
      if (readinessError) return readinessError;
      // The website's mirror requires non-empty content on every published
      // post (Interactor.Content.Post.changeset); a post published here with
      // empty content would fail to sync and log warnings forever. Check
      // stripped text, not raw HTML truthiness — a cleared contenteditable
      // div normalizes to "<p><br></p>", which is non-empty HTML but no
      // content.
      if (!stripHtml(post.content ?? "").trim()) {
        return conflict("Cannot publish a post with no content");
      }
      // No featured image: generate a title card (free, rendered on this
      // server — src/lib/featured-image.tsx) rather than refuse; refuse only
      // if generation itself fails.
      let generatedImage: { featured_image: string; featured_image_alt?: string } | null = null;
      if (!post.featured_image) {
        const generated = await generateFeaturedImageOrNull(db, actor, post);
        if (!generated) return conflict("Cannot publish a post with no featured image");
        generatedImage = {
          featured_image: generated.url,
          ...(!post.featured_image_alt?.trim() && { featured_image_alt: generated.alt }),
        };
      }
      // content:publish means "publish directly without approval", so an
      // unapproved draft is publishable — it gets marked approved here.
      const updated = await db.post.update({
        where: { id },
        data: {
          ...generatedImage,
          status: "published",
          published_at: post.published_at ?? new Date(),
          workflow_status: "approved",
          approved_at: post.approved_at ?? new Date(),
          approved_by_id: post.approved_by_id ?? actor.user.id,
          rejection_reason: null,
        },
      });
      await maybeProposeAmendment(updated);
      // Fire-and-forget (SEO-AEO-GEO-PLAN.md Layer D) — never awaited, never
      // allowed to slow down or fail the publish response itself.
      void notifyIndexNowForPost(db, updated, [updated.slug]);
      // The post now has a public URL, so its social drafts can carry the
      // link back to it. Same fire-and-forget rule: a failure here must not
      // fail the publish.
      void syncPostSocialDelivery(db, updated.id).catch(() => {});
      return NextResponse.json({ data: format(updated, actor), ...(await humanizerReport()) });
    }

    case "unpublish": {
      if (!actor.permissions.has("content:publish")) {
        return forbidden("Missing content:publish permission");
      }
      if (post.status !== "published") {
        return conflict("Post is not published");
      }
      const updated = await db.post.update({
        where: { id },
        data: { status: "draft", published_at: null },
      });
      void notifyIndexNowForPost(db, updated, [updated.slug]);
      return NextResponse.json({ data: format(updated, actor) });
    }

    default:
      return NextResponse.json(
        { error: "action must be one of submit|approve|reject|publish|unpublish" },
        { status: 400 }
      );
  }
}

// GET: approval history for the post
export async function GET(req: NextRequest, { params }: Ctx) {
  const { db, error } = await requirePermissionApi(req, "content:view");
  if (error) return error;

  const { id } = await params;
  const approvals = await db.contentApproval.findMany({
    where: { post_id: id },
    include: { reviewer: { select: { id: true, name: true, email: true } } },
    orderBy: { reviewed_at: "desc" },
  });

  return NextResponse.json({
    data: approvals.map((a) => ({
      ...a,
      reviewed_at: a.reviewed_at.toISOString(),
      inserted_at: a.inserted_at.toISOString(),
      updated_at: a.updated_at.toISOString(),
    })),
  });
}

function format(
  post: {
    id: string;
    author_id: string | null;
    inserted_at: Date;
    updated_at: Date;
    published_at: Date | null;
    approved_at: Date | null;
    preview_token_expires_at: Date | null;
    [key: string]: unknown;
  },
  actor: Actor
) {
  return {
    ...omitPreviewToken(post),
    inserted_at: post.inserted_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
    published_at: post.published_at?.toISOString() ?? null,
    approved_at: post.approved_at?.toISOString() ?? null,
    preview_url: previewUrlForActor(actor, post),
  };
}
