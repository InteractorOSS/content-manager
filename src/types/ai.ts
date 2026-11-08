// Types for the AI style-profile feature (CONTENT-AI-PLAN.md Phase A)

export interface StyleProfileSummary {
  id: string;
  name: string;
  scope: "user" | "org";
  owner_id: string | null;
  status: "draft" | "active" | "archived";
  sample_count: number;
  guide_count: number;
  pending_suggestion_count: number;
  updated_at: string;
}

export interface StyleSampleView {
  id: string;
  source_type: "url" | "upload" | "post" | "text";
  source_ref: string | null;
  title: string | null;
  text_preview: string;
  text_length: number;
  liked_notes: string | null;
  inserted_at: string;
}

export interface StyleGuideVersionView {
  id: string;
  version: number;
  guide: string;
  created_by: "analysis" | "interview" | "edit-learning" | "manual";
  inserted_at: string;
}

export interface StyleProfileDetail {
  id: string;
  name: string;
  scope: "user" | "org";
  owner_id: string | null;
  status: "draft" | "active" | "archived";
  can_manage: boolean;
  samples: StyleSampleView[];
  guides: StyleGuideVersionView[];
}

export interface AnalyzeResult {
  version: number;
  guide: string;
  created_by: string;
  usage: { input_tokens: number; output_tokens: number };
}

// Continuous learning (Phase D, CONTENT-AI-PLAN.md §4 point 5)
export interface GuideAmendmentSuggestionView {
  id: string;
  diff_summary: string;
  rationale: string;
  suggested_guide: string;
  status: "pending" | "accepted" | "rejected";
  post: { id: string; title: string; slug: string } | null;
  inserted_at: string;
  resolved_at: string | null;
}

export interface BlogRevision {
  title: string;
  excerpt: string;
  content_html: string;
  meta_description: string;
  meta_keywords: string;
  tags: string[];
}

export type GenerateFormat = "blog" | "linkedin" | "twitter" | "facebook";
export type SocialGenerateFormat = Exclude<GenerateFormat, "blog">;

export interface GenerateCreateResult {
  job_id: string;
  mode: "create";
  post: { id: string; slug: string; title: string } | null;
  // channel_ids: the SocialChannel(s) auto-attached as targets, one per
  // active connected channel matching the network (G#26). Empty when no
  // channel for that network is connected yet — the draft still lands in the
  // queue, just with nothing to schedule until one is added by hand.
  social_posts: { id: string; network: SocialGenerateFormat; channel_ids: string[] }[];
}

export interface GeneratePolishResult {
  job_id: string;
  mode: "polish";
  revision: BlogRevision;
}

export interface GenerateRequest {
  source: { type: "url" | "post" | "text"; url?: string; post_id?: string; text?: string };
  style_profile_id?: string;
  mode?: "create" | "polish";
  formats?: GenerateFormat[];
  instructions?: string;
}
