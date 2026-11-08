export type SocialChannelStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "error";

// G#27: "automated" publishes through Interactor Core (today's only
// behavior); "manual" means no API access exists for this channel at all
// (e.g. a personal Facebook profile) — a human posts the copy themselves
// from the manual queue and marks it posted.
export type SocialDeliveryMode = "automated" | "manual";

export interface SocialChannel {
  id: string;
  service_id: string;
  service_name: string;
  delivery_mode: SocialDeliveryMode;
  credential_id: string | null;
  /** Shared by every place one connection posts to; groups them on the page. */
  external_user_id: string;
  account_name: string | null;
  account_id: string | null;
  /** Whether a post's social copy goes here unless that post says otherwise. */
  default_target: boolean;
  avatar_url: string | null;
  status: SocialChannelStatus;
  connected_by?: { id: string; name: string | null; email: string } | null;
  inserted_at: string;
  updated_at: string;
}

export type SocialPostStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "scheduled"
  | "publishing"
  | "awaiting_manual"
  | "published"
  | "partially_published"
  | "failed"
  | "archived";

export type SocialTargetStatus =
  | "pending"
  | "publishing"
  | "awaiting_manual"
  | "published"
  | "failed"
  | "skipped";

/** One image/video on a social post — always a file from the org's media
 * library (src/lib/social/media.ts). `url`/`type` are copied from that file
 * when the post is saved; posts saved before S1 may lack `media_id`. */
export interface SocialMediaAttachment {
  media_id?: string;
  url: string;
  type?: string;
  alt?: string;
}

export interface SocialPostTarget {
  id: string;
  channel_id: string;
  channel?: SocialChannel;
  body_override: string | null;
  /** Media for this channel only; null = the post's media. */
  media_override: SocialMediaAttachment[] | null;
  status: SocialTargetStatus;
  external_post_id: string | null;
  external_url: string | null;
  error: string | null;
  attempt_count: number;
  /** When the scheduler will try this channel again; null once it is done. */
  next_attempt_at: string | null;
  /** Each part this target has published, by its place in the thread (0 = the
   * root, then each reply, then the first comment). */
  published_parts?: { kind: string; id: string | null; url?: string | null; at?: string }[] | null;
  published_at: string | null;
}

export interface SocialCampaign {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  recycle: boolean;
  post_count?: number;
}

export interface SocialPost {
  id: string;
  /** The first post; a thread's replies and a first comment are `parts`. */
  body: string;
  parts: import("@/lib/social/parts").SocialPart[];
  link: string | null;
  media: SocialMediaAttachment[];
  status: SocialPostStatus;
  rejection_reason: string | null;
  // AI fan-out provenance: the network the copy was written for and the blog
  // Post it was generated from. Both null for hand-written posts.
  network: string | null;
  source_post: { id: string; title: string; slug: string } | null;
  scheduled_at: string | null;
  published_at: string | null;
  campaign: SocialCampaign | null;
  created_by?: { id: string; name: string | null; email: string } | null;
  targets: SocialPostTarget[];
  inserted_at: string;
  updated_at: string;
}

export interface ConnectableService {
  service_id: string;
  display_name: string;
  char_limit?: number;
  requires_account_id?: boolean;
  requires_media?: boolean;
  /** How many images/videos one post may carry; null = no native media. */
  media_limits?: import("@/lib/social/media").MediaLimits | null;
  /** What the account id is for this service, e.g. "Subreddit", "Facebook Page". */
  account_label?: string | null;
  /** The account is picked from the connection's own list after connecting. */
  discovers_accounts?: boolean;
  /** The account id has to be typed before connecting (it can't be listed). */
  account_id_upfront?: boolean;
  /** Plain-language next step when the connection can reach no account. */
  no_accounts_help?: string | null;
  available: boolean; // present in the SKB catalog right now
}

/** One account a connected channel can publish to (a Page, a Slack channel). */
export interface ChannelAccountOption {
  id: string;
  name: string;
  /** Second line in the picker ("Your profile", "Linked to the Page …"). */
  detail?: string;
}

/**
 * G#27: one row of the manual-delivery queue — a SocialPostTarget still
 * awaiting_manual, with just enough of its parent post (the ready-to-paste
 * copy + media) to post it and mark it done without a second fetch.
 *
 * G#28: `effective_body`/`paste_text` pre-resolve the body_override-vs-
 * post.body precedence (same rule publisher.ts's automated path uses) so a
 * caller with no other CMS context — e.g. a Claude Desktop session driving
 * Facebook's composer via Claude in Chrome — never has to guess which copy
 * wins or how the link gets appended.
 */
export interface ManualQueueItem {
  id: string; // SocialPostTarget id — pass to mark_social_post_posted
  channel: SocialChannel;
  body_override: string | null;
  effective_body: string; // body_override || post.body — the copy to actually use
  paste_text: string; // effective_body, plus post.link on its own line when present
  status: SocialTargetStatus;
  inserted_at: string;
  updated_at: string;
  post: {
    id: string;
    body: string;
    link: string | null;
    media: SocialMediaAttachment[];
    network: string | null;
    campaign: SocialCampaign | null;
    source_post: { id: string; title: string; slug: string } | null;
    scheduled_at: string | null;
  };
}
