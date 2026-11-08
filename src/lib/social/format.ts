/** Serialize Prisma social rows for JSON responses (Date → ISO string). */

import { publishPlan } from "@/lib/social/capabilities";
import { resolveTargetMedia, storedMedia, storedMediaOverride } from "@/lib/social/media";
import { socialPostParts } from "@/lib/social/parts";

export function formatChannel(c: any) {
  return {
    ...c,
    inserted_at: c.inserted_at?.toISOString?.() ?? c.inserted_at,
    updated_at: c.updated_at?.toISOString?.() ?? c.updated_at,
  };
}

export function formatTarget(t: any) {
  return {
    ...t,
    channel: t.channel ? formatChannel(t.channel) : undefined,
    // null = this channel publishes the post's media; a list (even empty)
    // replaces it for this channel only.
    media_override: storedMediaOverride(t.media_override),
    next_attempt_at: t.next_attempt_at?.toISOString?.() ?? t.next_attempt_at ?? null,
    published_at: t.published_at?.toISOString?.() ?? t.published_at,
    inserted_at: t.inserted_at?.toISOString?.() ?? t.inserted_at,
    updated_at: t.updated_at?.toISOString?.() ?? t.updated_at,
  };
}

export function formatSocialPost(p: any) {
  return {
    ...p,
    // The root and what follows it. Old X copy that kept its thread as
    // `---` lines in the body is answered split, so every reader (and the
    // composer, which saves it back as parts) sees the thread as parts.
    ...socialPostParts(p),
    media: storedMedia(p.media),
    targets: Array.isArray(p.targets) ? p.targets.map(formatTarget) : [],
    scheduled_at: p.scheduled_at?.toISOString?.() ?? p.scheduled_at,
    published_at: p.published_at?.toISOString?.() ?? p.published_at,
    approved_at: p.approved_at?.toISOString?.() ?? p.approved_at,
    inserted_at: p.inserted_at?.toISOString?.() ?? p.inserted_at,
    updated_at: p.updated_at?.toISOString?.() ?? p.updated_at,
  };
}

/**
 * G#28: the same body-resolution rule publisher.ts's automated publish path
 * uses (`target.body_override || target.post.body`) and the CMS's manual
 * queue page re-derives client-side for its "Copy" button — computed once
 * here so every consumer of the manual queue (CMS UI, MCP tool) gets the
 * actual per-network copy instead of independently re-implementing the
 * override precedence (or missing it, and pasting the un-overridden post
 * body by mistake).
 */
function resolveManualBody(post: any, target: any): string {
  // A person pastes ONE text, so a thread and a first comment are joined into
  // it — the same rule publishPlan applies to any network without threads.
  const { body, parts } = socialPostParts(post);
  return publishPlan(null, target.body_override || body || "", parts).posts[0];
}

/**
 * G#27: one manual-queue row — a single SocialPostTarget still
 * awaiting_manual, flattened with just enough of its parent post (the
 * ready-to-paste copy + media) to post it and mark it done without a second
 * fetch. Takes the post and target separately (rather than a post whose
 * `targets` the caller has narrowed to one element) so the one-target
 * contract is explicit in the signature, not an unwritten convention of the
 * shape passed in.
 *
 * G#28: also carries `effective_body` and `paste_text` — an external
 * caller with no other CMS context (e.g. a Claude Desktop session using
 * Claude in Chrome to drive Facebook's own composer) has no way to know
 * `body_override` beats `post.body`, or that the CMS's own "Copy" button
 * appends the link on its own line. Both are pre-resolved here so calling
 * list_manual_social_queue is enough on its own to paste the right thing.
 */
export function formatManualQueueItem(post: any, target: any) {
  const effectiveBody = resolveManualBody(post, target);
  const pasteText = post.link ? `${effectiveBody}\n${post.link}` : effectiveBody;
  return {
    ...formatTarget(target),
    effective_body: effectiveBody,
    paste_text: pasteText,
    post: {
      id: post.id,
      body: post.body,
      link: post.link,
      // What THIS target publishes: its own media when it has an override,
      // so the person pasting attaches the right files.
      media: resolveTargetMedia(target, post),
      network: post.network,
      campaign: post.campaign ?? null,
      source_post: post.source_post ?? null,
      scheduled_at: post.scheduled_at?.toISOString?.() ?? post.scheduled_at,
    },
  };
}
