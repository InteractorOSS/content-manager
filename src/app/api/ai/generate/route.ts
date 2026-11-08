import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { canEditPost, authorDisplayName } from "@/lib/rbac";
import { aiConfigured, AI_MODEL } from "@/lib/ai/client";
import { extractFromUrl, htmlToText } from "@/lib/ai/extract";
import {
  buildStyleSystem,
  generateBlogDraft,
  generateSocialCopy,
  isSocialFormat,
  polishDraft,
  type SocialFormat,
} from "@/lib/ai/generate";
import { sanitizePostContent } from "@/lib/sanitize";
import { stripHtml } from "@/lib/utils";
import { serviceIdsForNetwork } from "@/lib/social/capabilities";
import { syncPostSocialDelivery } from "@/lib/post-social-delivery";

export const maxDuration = 300;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 96);
}

function readingTime(html: string): number {
  const words = stripHtml(html).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

async function latestGuide(profileId: string): Promise<string | null> {
  const version = await prisma.styleGuideVersion.findFirst({
    where: { profile_id: profileId },
    orderBy: { version: "desc" },
  });
  return version?.guide ?? null;
}

// Phase B: blog generation ("create" from url/text/post) and draft polish
// ("polish" on an existing post — returns the revision for a diff view,
// nothing is saved until the author applies it in the editor).
export async function POST(req: NextRequest) {
  const { actor, db, error } = await requirePermission("content:create");
  if (error) return error;

  if (!aiConfigured()) {
    return NextResponse.json(
      { error: "AI is not configured — set ANTHROPIC_API_KEY on the server" },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    source?: { type?: string; post_id?: string; url?: string; text?: string };
    style_profile_id?: string;
    mode?: string;
    formats?: string[];
    instructions?: string;
  };

  const mode = body.mode === "polish" ? "polish" : "create";
  const source = body.source ?? {};

  // Phase C: fan one source out into several formats. "blog" creates a draft
  // Post; social formats create draft SocialPost rows for the social pipeline.
  const requestedFormats = body.formats?.length ? body.formats : ["blog"];
  const invalidFormat = requestedFormats.find(
    (f) => f !== "blog" && !isSocialFormat(f)
  );
  if (mode === "create" && invalidFormat) {
    return NextResponse.json(
      { error: `Unknown format "${invalidFormat}" — use blog, linkedin, twitter, facebook` },
      { status: 400 }
    );
  }
  const wantsBlog = requestedFormats.includes("blog");
  const socialFormats = requestedFormats.filter(isSocialFormat) as SocialFormat[];

  // Resolve style guides: brand (active org profile) + personal (selected).
  let personalGuide: string | null = null;
  if (body.style_profile_id) {
    const profile = await db.styleProfile.findUnique({
      where: { id: body.style_profile_id },
    });
    if (!profile) {
      return NextResponse.json({ error: "Style profile not found" }, { status: 404 });
    }
    if (profile.scope === "user" && profile.owner_id !== actor.user.id && !actor.permissions.has("admin:settings")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    personalGuide = await latestGuide(profile.id);
  }
  const orgProfile = await db.styleProfile.findFirst({
    where: { scope: "org", status: "active", id: { not: body.style_profile_id ?? "" } },
    orderBy: { updated_at: "desc" },
  });
  const brandGuide = orgProfile ? await latestGuide(orgProfile.id) : null;
  const styleSystem = buildStyleSystem(brandGuide, personalGuide);

  const job = await db.generationJob.create({
    data: {
      requested_by: actor.user.id,
      profile_id: body.style_profile_id ?? null,
      source_type: source.type ?? "text",
      source_ref: source.post_id ?? source.url ?? null,
      formats: mode === "polish" ? ["blog"] : requestedFormats,
      mode,
      model: AI_MODEL,
    },
  });

  const fail = async (message: string, status = 422) => {
    await db.generationJob.update({
      where: { id: job.id },
      data: { status: "failed", error: message },
    });
    return NextResponse.json({ error: message }, { status });
  };

  try {
    if (mode === "polish") {
      if (source.type !== "post" || !source.post_id) {
        return await fail("polish mode requires source.type=post with post_id", 400);
      }
      const post = await db.post.findUnique({ where: { id: source.post_id } });
      if (!post) return await fail("Post not found", 404);
      if (!canEditPost(actor, post)) return await fail("You can only polish posts you can edit", 403);

      const { draft, usage } = await polishDraft(
        styleSystem,
        { title: post.title, content_html: post.content ?? "", excerpt: post.excerpt },
        body.instructions
      );
      const content = sanitizePostContent(draft.content_html);

      await db.generationJob.update({
        where: { id: job.id },
        data: {
          status: "done",
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          outputs: { post_id: post.id, applied: false },
        },
      });

      // Returned for the diff view; the editor applies it via the normal
      // update path so workflow/permissions stay unchanged.
      return NextResponse.json({
        data: {
          job_id: job.id,
          mode,
          revision: { ...draft, content_html: content },
        },
      });
    }

    // mode === "create"
    let sourceText = "";
    if (source.type === "url" && source.url) {
      const extracted = await extractFromUrl(source.url);
      sourceText = (extracted.title ? `Title: ${extracted.title}\n\n` : "") + extracted.text;
    } else if (source.type === "post" && source.post_id) {
      const post = await db.post.findUnique({ where: { id: source.post_id } });
      if (!post) return await fail("Post not found", 404);
      sourceText = `Title: ${post.title}\n\n${htmlToText(post.content ?? "")}`;
    } else if (source.type === "text" && source.text) {
      sourceText = String(source.text);
    } else {
      return await fail("Provide source.type=url|post|text with url/post_id/text", 400);
    }
    if (stripHtml(sourceText).length < 100) {
      return await fail("Source material is too short to generate from", 400);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let post: { id: string; slug: string; title: string } | null = null;
    let socialSourceText = sourceText;
    // Social drafts link back to the blog Post they promote: the freshly
    // generated one, or the source post when fanning out an existing draft.
    let sourcePostId = source.type === "post" ? source.post_id ?? null : null;

    if (wantsBlog) {
      const { draft, usage } = await generateBlogDraft(styleSystem, sourceText, body.instructions);
      const content = sanitizePostContent(draft.content_html);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;

      let slug = slugify(draft.title) || `post-${job.id.slice(-8)}`;
      const slugTaken = await db.post.findFirst({ where: { slug } });
      if (slugTaken) slug = `${slug}-${job.id.slice(-6)}`;

      const created = await db.post.create({
        data: {
          title: draft.title,
          slug,
          content,
          content_format: "html",
          excerpt: draft.excerpt || null,
          status: "draft",
          workflow_status: "draft",
          type: "blog",
          meta_description: draft.meta_description || null,
          meta_keywords: draft.meta_keywords || null,
          tags: draft.tags.slice(0, 8),
          author_name: authorDisplayName(actor.user),
          author_id: actor.user.id,
          reading_time: readingTime(content),
          // Continuous learning (Phase D): snapshot the AI baseline so the
          // workflow route can diff it against the author's edits later.
          // Only set when a specific profile was selected — that's the guide
          // an amendment would apply to.
          ...(body.style_profile_id && {
            ai_style_profile_id: body.style_profile_id,
            ai_generated_content: content,
            ai_generated_at: new Date(),
          }),
        },
      });
      post = { id: created.id, slug: created.slug, title: created.title };
      sourcePostId = created.id;
      // Social copy promotes the article the reader will actually see.
      socialSourceText = `Title: ${draft.title}\n\n${htmlToText(content)}`;
    }

    // G#26: fan-out previously left every AI-generated SocialPost with zero
    // targets — nothing to schedule until a human opened the queue and picked
    // channels by hand. Look up this organization's active channels for each
    // requested network ONCE, up front, then attach one SocialPostTarget per
    // matching channel when each SocialPost is created. A network with no
    // connected channel yet still gets its draft (nothing to attach to; the
    // writer connects one later and adds it from the queue, same as a
    // hand-written draft).
    const wantedServiceIds = [...new Set(socialFormats.flatMap((f) => serviceIdsForNetwork(f)))];
    const activeChannels =
      wantedServiceIds.length > 0
        ? await db.socialChannel.findMany({
            where: { service_id: { in: wantedServiceIds }, status: "active" },
            select: { id: true, service_id: true },
          })
        : [];

    const socialPosts: { id: string; network: SocialFormat; channel_ids: string[] }[] = [];
    for (const format of socialFormats) {
      const { body: copy, parts, usage } = await generateSocialCopy(
        styleSystem,
        format,
        socialSourceText,
        body.instructions
      );
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      const targetChannels = activeChannels.filter((c) =>
        serviceIdsForNetwork(format).includes(c.service_id)
      );
      const socialPost = await db.socialPost.create({
        data: {
          body: copy,
          parts: parts as unknown as Prisma.InputJsonValue,
          status: "draft",
          network: format,
          source_post_id: sourcePostId,
          created_by_id: actor.user.id,
          targets: {
            create: targetChannels.map((c) => ({ channel_id: c.id })),
          },
        },
      });
      socialPosts.push({ id: socialPost.id, network: format, channel_ids: targetChannels.map((c) => c.id) });
    }

    // The drafts above were attached to every active channel of their
    // network. Bring them in line with where this post actually goes (the
    // channels' defaults, or the post's own choice) and give them the link
    // back to the post — the same pass a hand-written draft gets on save.
    if (sourcePostId && socialPosts.length > 0) {
      await syncPostSocialDelivery(db, sourcePostId).catch(() => {});
    }

    await db.generationJob.update({
      where: { id: job.id },
      data: {
        status: "done",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        outputs: {
          ...(post ? { blog: post.id } : {}),
          ...(socialPosts.length
            ? { social: Object.fromEntries(socialPosts.map((p) => [p.network, p.id])) }
            : {}),
        },
      },
    });

    return NextResponse.json(
      { data: { job_id: job.id, mode, post, social_posts: socialPosts } },
      { status: 201 }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Generation failed";
    return await fail(message, 502);
  }
}
