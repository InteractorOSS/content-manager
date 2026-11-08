export type PostStatus = "draft" | "published" | "archived";
/**
 * Content type is an OPEN token, not a closed union (G#19) — orgs register
 * their own in the ContentType table. The four names below are the built-in
 * seeds every org starts with; the `(string & {})` arm keeps them as editor
 * autocomplete hints while still accepting any registered or imported type.
 */
export type BuiltInPostType = "blog" | "news" | "announcement" | "article";
export type PostType = BuiltInPostType | (string & {});

export const BUILT_IN_POST_TYPES: readonly BuiltInPostType[] = [
  "blog",
  "news",
  "announcement",
  "article",
];

export interface ContentType {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
}

/**
 * A distribution target (G#18) — one consuming site a post can be surfaced on.
 * Same shape as ContentType (both are org-scoped registries), but with no
 * built-in seeds of its own — every org starts with none, since a shared
 * default would imply an affiliation (e.g. with Interactor's own sites) that
 * most orgs don't have. An `id` of `in-use:` marks a slug some post already
 * carries that nobody has registered a row for yet (see mergeSites()).
 *
 * `url` is the site's base URL, used to build its RSS feed/sitemap links —
 * required on a real (DB-backed) row, but null on a virtual `in-use:` entry,
 * since there's nothing to link to until someone registers it for real.
 */
export interface Site {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  url: string | null;
  sort_order: number;
  // IndexNow verification key (G#34) — null for a virtual "in-use" entry
  // (mergeSites) and for a registered site that predates this column and has
  // never been read through `GET /api/public/indexnow-key` (which lazily
  // generates and persists one on first read — see src/lib/indexnow.ts).
  indexnow_key: string | null;
}
export type WorkflowStatus = "draft" | "pending_review" | "approved" | "rejected";

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  sort_order: number;
  inserted_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  title: string;
  slug: string;
  content: string | null;
  // Rendered + sanitized HTML cache of `content` (markdown is rendered,
  // html mirrors `content` verbatim) — see FILE-BASED-CONTENT-PLAN.md D2.
  content_html: string | null;
  content_hash: string | null;
  // Phase 2 (git two-way sync) — see FILE-BASED-CONTENT-PLAN.md.
  last_synced_hash: string | null;
  sync_conflict: boolean;
  content_format: string;
  content_styles: string | null;
  excerpt: string | null;
  status: PostStatus;
  type: PostType;
  featured_image: string | null;
  featured_image_alt: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  seo_title: string | null;
  canonical_url: string | null;
  og_image: string | null;
  og_image_alt: string | null;
  noindex: boolean;
  answer_summary: string | null;
  redirect_to: string | null;
  // Honest "Updated <date>" (G#31) — moves only on a substantive edit or an
  // explicit mark_updated, unlike updated_at, which any write bumps.
  content_updated_at: string | null;
  author_name: string | null;
  author_id: string | null;
  published_at: string | null;
  reading_time: number | null;
  tags: string[];
  platforms: string[];
  category_id: string | null;
  category: Pick<Category, "id" | "name" | "slug"> | null;
  workflow_status: WorkflowStatus;
  rejection_reason: string | null;
  approved_at: string | null;
  approved_by_id: string | null;
  // Draft preview links (G#13): an openable URL for the post's single active
  // signed preview link, or null when none is live.
  preview_url: string | null;
  updated_by_id: string | null;
  updated_by_name: string | null;
  inserted_at: string;
  updated_at: string;
}

export type PostRevisionSource = "cms_ui" | "api" | "mcp" | "import" | "restore" | "writing" | "checkpoint";

/** Metadata-only shape from GET /api/cms/posts/[id]/revisions (no content body). */
export interface PostRevisionMeta {
  id: string;
  title: string;
  source: PostRevisionSource;
  /** Set on an explicit checkpoint, e.g. "Before rewriting the intro". */
  label: string | null;
  edited_by: { id: string; name: string | null; email: string } | null;
  inserted_at: string;
}

/** Full shape from GET /api/cms/posts/[id]/revisions/[revisionId]. */
export interface PostRevision extends PostRevisionMeta {
  post_id: string;
  content: string | null;
  content_format: string;
  content_html: string | null;
  excerpt: string | null;
  content_hash: string | null;
  edited_by_id: string | null;
}

export type FaqCategory = "pricing" | "self-hosting" | "security" | "hosted-fleet" | "ci" | "billing";
export type FaqAudience = "public" | "sales-only";
export type FaqStatus = "draft" | "review" | "published";

export interface FaqRevision {
  id: string;
  answer: string;
  edited_by_id: string | null;
  inserted_at: string;
}

export interface Faq {
  id: string;
  slug: string;
  question: string;
  answer: string;
  category: FaqCategory;
  audience: FaqAudience;
  status: FaqStatus;
  last_verified: string | null;
  verify_every_days: number;
  sources: string[];
  related: string[];
  asked_count: number;
  revisions?: FaqRevision[];
  inserted_at: string;
  updated_at: string;
}

export interface Media {
  id: string;
  filename: string;
  original_filename: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  alt_text: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  uploaded_by: string | null;
  inserted_at: string;
  updated_at: string;
}

// API response shapes
export interface ApiListResponse<T> {
  data: T[];
  meta?: {
    total?: number;
    page?: number;
    per_page?: number;
  };
}

export interface ApiSingleResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
  message?: string;
  errors?: Record<string, string[]>;
}

// Form types
export interface PostFormValues {
  title: string;
  slug: string;
  content: string;
  content_format: string;
  content_styles: string;
  excerpt: string;
  status: PostStatus;
  type: PostType;
  featured_image: string;
  featured_image_alt: string;
  meta_description: string;
  meta_keywords: string;
  author_name: string;
  published_at: string;
  tags: string[];
  platforms: string[];
  category_id: string;
  // Continuous learning (Phase D): present only when this save applies an
  // AI polish revision unchanged — stamps the baseline the workflow route
  // diffs against later. See CONTENT-AI-PLAN.md §4 point 5.
  ai_snapshot?: { profile_id: string; content: string };
  // content_hash the editor loaded this post with — lets the server refuse
  // (409) a save that would clobber an edit made by someone else since.
  expected_content_hash?: string | null;
}

export interface CategoryFormValues {
  name: string;
  slug: string;
  description: string;
  color: string;
  sort_order: number;
}

export interface FaqFormValues {
  question: string;
  answer: string;
  category: FaqCategory;
  audience: FaqAudience;
  status: FaqStatus;
  last_verified: string;
  verify_every_days: number;
  sources: string[];
  related: string[];
}

// Dashboard stats
export interface DashboardStats {
  totalPosts: number;
  publishedPosts: number;
  draftPosts: number;
  archivedPosts: number;
  totalCategories: number;
  totalTags: number;
  totalMedia: number;
  recentPosts: Post[];
}

// SEO generation response (G#35): an LLM pass drafts these fields when AI is
// configured (source: "llm"); otherwise a heuristic fallback fills the first
// four and leaves the rest empty (source: "heuristic"). Every field is a
// SUGGESTION for the editor's "Suggestions" panel — nothing here is ever
// written to the post except by an explicit accept action.
export interface SeoGenerateResponse {
  success: boolean;
  data: {
    meta_description: string;
    meta_keywords: string;
    excerpt: string;
    featured_image_alt: string;
    seo_title: string | null;
    answer_summary: string | null;
    question_headings: string[];
    citations_needed: string[];
    faq: { question: string; answer: string }[];
    source: "llm" | "heuristic";
  };
}

// Image upload response
export interface ImageUploadResponse {
  success: boolean;
  file: {
    url: string;
    title: string;
  };
}

// Tag search response
export interface TagSearchResponse {
  tags: string[];
}

// ─── Users, roles, invitations, workflow ─────────────────────────────────────

/** An org the current user belongs to, with their role and whether it's active. */
export type OrganizationSummary = OrganizationRef & {
  role: string;
  active: boolean;
};

export interface Me {
  user: {
    id: string;
    email: string;
    name: string | null;
    display_name: string | null;
    status: string;
  };
  // Current org context (T3). Over a PAT the active org is the one the token
  // is bound to; over a session it is User.current_organization_id, which the
  // switcher (T5) writes.
  organization_id: string | null;
  organization: OrganizationRef | null;
  membership_role: string | null;
  /** Every org this user belongs to, with their role in each — drives the switcher (T5). */
  organizations: OrganizationSummary[];
  /**
   * Merged display list: the membership role plus "super_admin" when the
   * global grant is held. Never gate the global grant on this — a
   * Membership.role of "super_admin" lands here too. Use
   * {@link is_super_admin}.
   */
  roles: string[];
  /** The GLOBAL, cross-org super_admin grant. */
  is_super_admin: boolean;
  permissions: string[];
  /** Which credential answered — see /api/me. */
  auth_method: "session" | "token";
  /** The token that answered, when auth_method is "token". */
  token: {
    id: string;
    name: string;
    token_prefix: string;
    expires_at: string | null;
    site_scopes: string[];
  } | null;
}

/** A single org's full record, as returned by GET /api/organizations/[id]. */
export interface Organization extends OrganizationRef {
  role: string;
  logo: string | null;
  branding: unknown;
}

/**
 * A member of the current organization, as returned by GET /api/users.
 *
 * The two role systems are kept apart deliberately: `membership_role` is the
 * single, per-org role permissions flatten from, while `super_admin` is the
 * global cross-org grant. They used to arrive merged into one `roles` array,
 * which is how the editor came to offer super_admin as if it were an org role.
 */
export interface CmsUser {
  /**
   * Unique per ROW, not per person: a cross-org listing (`?scope=all`) returns
   * someone who belongs to three organizations three times, once per role they
   * hold. Key lists on this rather than on `id`.
   */
  membership_id: string;
  id: string;
  email: string;
  name: string | null;
  status: string;
  avatar_url: string | null;
  /** Effective role in {@link organization} — what permissions flatten from. */
  membership_role: string;
  /** Label for {@link membership_role}; no second request to /api/roles. */
  membership_role_display_name: string;
  /** The organization this row's role is held in. */
  organization: { id: string; name: string; slug: string };
  super_admin: boolean;
  /** Posts authored in this organization (all orgs in a cross-org listing). */
  post_count: number;
  last_login_at: string | null;
  /** When they joined {@link organization}. */
  joined_at: string;
  inserted_at: string;
}

export interface Role {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  priority: number;
  permissions: string[];
  user_count: number;
  /** "organization" for a Membership role; "global" for super_admin. */
  scope: "organization" | "global";
  /** Whether the signed-in admin may hand this role out (server-enforced too). */
  assignable: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  name: string | null;
  role_name: string;
  status: string;
  notes: string | null;
  invited_by: { id: string; name: string | null; email: string } | null;
  expires_at: string;
  accepted_at: string | null;
  last_sent_at: string | null;
  inserted_at: string;
}

export interface ContentApproval {
  id: string;
  post_id: string;
  action: "approved" | "rejected" | "requested_changes";
  comments: string | null;
  reviewer: { id: string; name: string | null; email: string } | null;
  reviewed_at: string;
}

export type WorkflowAction = "submit" | "approve" | "reject" | "publish" | "unpublish";

// Personal access tokens — non-browser auth for desktop/CLI file sync
// (see FILE-BASED-CONTENT-PLAN.md Phase 1).
export interface ApiToken {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  inserted_at: string;
  // The single organization this token may act on, fixed at mint time. Null
  // only for a pre-binding token that could not be backfilled; such a token is
  // refused at request time, so the UI shows it as unusable.
  organization_id: string | null;
  organization: OrganizationRef | null;
  // Optional site scope (G#21): site slugs this token is scoped to, or empty
  // for all sites in the org. Set at mint time and never changed.
  site_scopes: string[];
  // Set when the row is an app connected through OAuth (e.g. Claude's custom
  // connector) instead of a hand-minted token. Its expires_at is when the
  // connection lapses without use; the access token itself renews silently.
  connected_app?: { name: string } | null;  // A workspace connection: every organization of its accounts (the owner's,
  // plus linked_accounts added on the consent page). organization is null.
  all_organizations?: boolean;
  linked_accounts?: string[];
}

export interface OrganizationRef {
  id: string;
  name: string;
  slug: string;
}

export interface ApiTokenCreated extends ApiToken {
  // Only present in the create response — shown to the user exactly once.
  token: string;
}

// ─── Submissions ──────────────────────────────────────────────────────────────

export interface ContactSubmission {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string | null;
  jobTitle: string | null;
  phone: string | null;
  productInterest: string | null;
  country: string | null;
  subject: string | null;
  message: string;
  type: string;
  status: string;
  source: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterSubscription {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  status: string;
  source: string | null;
  preferences: Record<string, unknown> | null;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  status: string;
  source: string | null;
  metadata: Record<string, unknown> | null;
  confirmedAt: string | null;
  invitedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Feedback {
  id: string;
  type: string;
  source: string;
  status: string;
  title: string;
  body: string | null;
  author_name: string | null;
  author_email: string | null;
  submitted_by_id: string | null;
  page_url: string | null;
  user_agent: string | null;
  screenshot_url: string | null;
  metadata: Record<string, unknown> | null;
  ticket_number: number | null;
  ticket_url: string | null;
  ticket_error: string | null;
  inserted_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  postId: string;
  postTitle: string;
  postSlug: string;
  authorName: string;
  authorEmail: string;
  content: string;
  status: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The signed-in person's own profile (/api/me/profile). */
export interface MyProfile {
  email: string;
  name: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  // Entity fields (G#31): a public /author/<slug> page, job title, and
  // canonical profile URLs (Person JSON-LD `sameAs`).
  author_slug: string | null;
  job_title: string | null;
  same_as: string[];
  /** What a new post is credited as right now. */
  byline: string;
}
