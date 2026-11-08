import type {
  Post,
  Category,
  Media,
  PostFormValues,
  CategoryFormValues,
  Faq,
  FaqFormValues,
  PostRevision,
  PostRevisionMeta,
  SeoGenerateResponse,
  ImageUploadResponse,
  TagSearchResponse,
  ContactSubmission,
  NewsletterSubscription,
  WaitlistEntry,
  Comment,
  Me,
  MyProfile,
  CmsUser,
  Role,
  Invitation,
  ContentApproval,
  WorkflowAction,
  ApiToken,
  ApiTokenCreated,
  ContentType,
  Site,
  Organization,
  OrganizationSummary,
} from "@/types/cms";

const CMS_BASE = "/api/cms";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${CMS_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function requestFormData<T>(
  path: string,
  formData: FormData,
  method: string = "POST"
): Promise<T> {
  const url = `${CMS_BASE}${path}`;
  const response = await fetch(url, {
    method,
    body: formData,
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    throw new ApiError(response.status, `HTTP ${response.status}`, body);
  }

  return response.json() as Promise<T>;
}

// ─── Posts ────────────────────────────────────────────────────────────────────

export interface ListPostsParams {
  type?: string;
  category_id?: string;
  published?: boolean;
  workflow_status?: string;
  page?: number;
  per_page?: number;
}

export async function listPosts(params: ListPostsParams = {}): Promise<Post[]> {
  const qs = new URLSearchParams();
  if (params.type) qs.set("type", params.type);
  if (params.category_id) qs.set("category_id", params.category_id);
  if (params.published !== undefined)
    qs.set("published", String(params.published));
  if (params.workflow_status) qs.set("workflow_status", params.workflow_status);
  if (params.page) qs.set("page", String(params.page));
  if (params.per_page) qs.set("per_page", String(params.per_page));

  const query = qs.toString();
  const data = await request<{ data: Post[] }>(`/posts${query ? `?${query}` : ""}`);
  return data.data;
}

export async function importPostFile(values: {
  raw: string;
  filename?: string;
  force?: boolean;
}): Promise<{ data: Post; created: boolean; warning?: string }> {
  const query = values.force ? "?force=true" : "";
  return request(`/posts/import${query}`, {
    method: "POST",
    body: JSON.stringify({ raw: values.raw, filename: values.filename }),
  });
}

export async function getPost(id: string): Promise<Post> {
  const data = await request<{ data: Post }>(`/posts/${id}`);
  return data.data;
}

export async function getPostBySlug(slug: string): Promise<Post> {
  const data = await request<{ data: Post }>(`/posts/slug/${slug}`);
  return data.data;
}

export async function createPost(values: Partial<PostFormValues>): Promise<Post> {
  const data = await request<{ data: Post }>("/posts", {
    method: "POST",
    body: JSON.stringify({ post: values }),
  });
  return data.data;
}

export async function updatePost(
  id: string,
  values: Partial<PostFormValues>
): Promise<Post> {
  const data = await request<{ data: Post }>(`/posts/${id}`, {
    method: "PUT",
    body: JSON.stringify({ post: values }),
  });
  return data.data;
}

export async function deletePost(id: string): Promise<void> {
  await request<void>(`/posts/${id}`, { method: "DELETE" });
}

export async function listPostRevisions(
  id: string
): Promise<{ data: PostRevisionMeta[]; meta: { total: number; page: number; per_page: number } }> {
  return request(`/posts/${id}/revisions`);
}

export async function getPostRevision(id: string, revisionId: string): Promise<PostRevision> {
  const data = await request<{ data: PostRevision }>(`/posts/${id}/revisions/${revisionId}`);
  return data.data;
}

export async function restorePostRevision(
  id: string,
  revisionId: string,
  expectedContentHash?: string | null
): Promise<Post> {
  const data = await request<{ data: Post }>(`/posts/${id}/revisions/${revisionId}/restore`, {
    method: "POST",
    ...(expectedContentHash !== undefined && {
      body: JSON.stringify({ expected_content_hash: expectedContentHash }),
    }),
  });
  return data.data;
}

export async function workflowAction(
  id: string,
  action: WorkflowAction,
  options: { comments?: string; reason?: string } = {}
): Promise<Post> {
  const data = await request<{ data: Post }>(`/posts/${id}/workflow`, {
    method: "POST",
    body: JSON.stringify({ action, ...options }),
  });
  return data.data;
}

export async function getApprovalHistory(id: string): Promise<ContentApproval[]> {
  const data = await request<{ data: ContentApproval[] }>(`/posts/${id}/workflow`);
  return data.data;
}

export async function publishPost(id: string): Promise<Post> {
  return workflowAction(id, "publish");
}

export async function unpublishPost(id: string): Promise<Post> {
  return workflowAction(id, "unpublish");
}

export async function createPreviewLink(id: string): Promise<{ url: string; expires_at: string }> {
  const data = await request<{ data: { url: string; expires_at: string } }>(
    `/posts/${id}/preview-link`,
    { method: "POST" }
  );
  return data.data;
}

export async function revokePreviewLink(id: string): Promise<void> {
  await request<void>(`/posts/${id}/preview-link`, { method: "DELETE" });
}

export async function resolveSyncConflict(id: string, expectedContentHash?: string | null): Promise<Post> {
  const data = await request<{ data: Post }>(`/posts/${id}/resolve-conflict`, {
    method: "POST",
    ...(expectedContentHash !== undefined && {
      body: JSON.stringify({ expected_content_hash: expectedContentHash }),
    }),
  });
  return data.data;
}

export async function bulkDeletePosts(ids: string[]): Promise<void> {
  await request<void>("/posts/bulk-delete", {
    method: "DELETE",
    body: JSON.stringify({ ids }),
  });
}

export async function generateSeo(
  title: string,
  content: string
): Promise<SeoGenerateResponse> {
  return request<SeoGenerateResponse>("/posts/generate-seo", {
    method: "POST",
    body: JSON.stringify({ title, content }),
  });
}

export interface ReadinessFinding {
  key: string;
  message: string;
}

/** Search & AI readiness check (G#32) — what the publish/approve gate will refuse on, plus advisory warnings. */
export interface PostSeoCheck {
  errors: ReadinessFinding[];
  warnings: ReadinessFinding[];
  /** Humanizer: `reviewed` is false when the model review didn't run (no AI key, or it failed). */
  humanizer?: { version: string; reviewed: boolean };
}

export async function checkPostSeo(postId: string): Promise<PostSeoCheck> {
  const res = await request<{ data: PostSeoCheck }>(`/posts/${postId}/seo-check`);
  return res.data;
}

/** Render a free title-card featured image for a saved post and set it. */
export async function generateFeaturedImage(postId: string): Promise<{
  id: string;
  featured_image: string;
  featured_image_alt: string | null;
  media_id: string;
}> {
  const res = await request<{
    data: { id: string; featured_image: string; featured_image_alt: string | null; media_id: string };
  }>(`/posts/${postId}/featured-image`, { method: "POST" });
  return res.data;
}

export async function uploadImage(
  file: File,
  altText?: string
): Promise<ImageUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (altText) formData.append("alt_text", altText);
  return requestFormData<ImageUploadResponse>("/media", formData);
}

export async function searchTags(q: string): Promise<TagSearchResponse> {
  return request<TagSearchResponse>(`/tags?q=${encodeURIComponent(q)}`);
}

export async function deleteTag(tag: string): Promise<void> {
  await request<void>(`/tags?tag=${encodeURIComponent(tag)}`, { method: "DELETE" });
}

// ─── Content types ────────────────────────────────────────────────────────────

/** The org's content-type registry, merged with built-in seeds and types
 *  already in use (see src/lib/content-types.ts). */
export async function listContentTypes(): Promise<ContentType[]> {
  const data = await request<{ data: ContentType[] }>("/content-types");
  return data.data;
}

// ─── Sites (distribution targets, G#18) ───────────────────────────────────────

/** The org's site registry, merged with built-in seeds and slugs already in
 *  use (see src/lib/sites.ts). */
export async function listSites(): Promise<Site[]> {
  const data = await request<{ data: Site[] }>("/sites");
  return data.data;
}

export async function createSite(values: {
  slug: string;
  name?: string;
  description?: string;
  url: string;
}): Promise<Site> {
  const data = await request<{ data: Site }>("/sites", {
    method: "POST",
    body: JSON.stringify({ site: values }),
  });
  return data.data;
}

export async function updateSite(
  id: string,
  values: { slug?: string; name?: string; description?: string; url?: string }
): Promise<Site> {
  const data = await request<{ data: Site }>(`/sites/${id}`, {
    method: "PUT",
    body: JSON.stringify({ site: values }),
  });
  return data.data;
}

export async function deleteSite(id: string): Promise<void> {
  await request<void>(`/sites/${id}`, { method: "DELETE" });
}

// ─── Categories ───────────────────────────────────────────────────────────────

export async function listCategories(): Promise<Category[]> {
  const data = await request<{ data: Category[] }>("/categories");
  return data.data;
}

export async function getCategory(id: string): Promise<Category> {
  const data = await request<{ data: Category }>(`/categories/${id}`);
  return data.data;
}

export async function createCategory(
  values: Partial<CategoryFormValues>
): Promise<Category> {
  const data = await request<{ data: Category }>("/categories", {
    method: "POST",
    body: JSON.stringify({ category: values }),
  });
  return data.data;
}

export async function updateCategory(
  id: string,
  values: Partial<CategoryFormValues>
): Promise<Category> {
  const data = await request<{ data: Category }>(`/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify({ category: values }),
  });
  return data.data;
}

export async function deleteCategory(id: string): Promise<void> {
  await request<void>(`/categories/${id}`, { method: "DELETE" });
}

// ─── FAQ ──────────────────────────────────────────────────────────────────────

export interface ListFaqsParams {
  status?: string;
  category?: string;
  audience?: string;
}

export async function listFaqs(params: ListFaqsParams = {}): Promise<Faq[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.category) qs.set("category", params.category);
  if (params.audience) qs.set("audience", params.audience);
  const query = qs.toString();
  const data = await request<{ data: Faq[] }>(`/faqs${query ? `?${query}` : ""}`);
  return data.data;
}

export async function getFaq(id: string): Promise<Faq> {
  const data = await request<{ data: Faq }>(`/faqs/${id}`);
  return data.data;
}

export async function createFaq(values: Partial<FaqFormValues>): Promise<Faq> {
  const data = await request<{ data: Faq }>("/faqs", {
    method: "POST",
    body: JSON.stringify({ faq: values }),
  });
  return data.data;
}

export async function updateFaq(id: string, values: Partial<FaqFormValues>): Promise<Faq> {
  const data = await request<{ data: Faq }>(`/faqs/${id}`, {
    method: "PUT",
    body: JSON.stringify({ faq: values }),
  });
  return data.data;
}

export async function deleteFaq(id: string): Promise<void> {
  await request<void>(`/faqs/${id}`, { method: "DELETE" });
}

// ─── Media ────────────────────────────────────────────────────────────────────

export async function listMedia(): Promise<Media[]> {
  const data = await request<{ data: Media[] }>("/media");
  return data.data;
}

export async function getMedia(id: string): Promise<Media> {
  const data = await request<{ data: Media }>(`/media/${id}`);
  return data.data;
}

export async function uploadMedia(
  file: File,
  metadata?: { alt_text?: string; caption?: string }
): Promise<Media> {
  const formData = new FormData();
  formData.append("file", file);
  if (metadata?.alt_text) formData.append("alt_text", metadata.alt_text);
  if (metadata?.caption) formData.append("caption", metadata.caption);
  const data = await requestFormData<{ data: Media }>("/media", formData);
  return data.data;
}

export async function deleteMedia(id: string): Promise<void> {
  await request<void>(`/media/${id}`, { method: "DELETE" });
}

// ─── Submissions (contacts, newsletter, waitlist) ─────────────────────────────

async function submissionsRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { body = {}; }
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, body);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listContacts(params: { status?: string; type?: string } = {}): Promise<ContactSubmission[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.type) qs.set("type", params.type);
  const query = qs.toString();
  return submissionsRequest<ContactSubmission[]>(`/api/contacts${query ? `?${query}` : ""}`);
}

export async function getContact(id: string): Promise<ContactSubmission> {
  return submissionsRequest<ContactSubmission>(`/api/contacts/${id}`);
}

export async function updateContactStatus(id: string, status: string): Promise<ContactSubmission> {
  return submissionsRequest<ContactSubmission>(`/api/contacts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function deleteContact(id: string): Promise<void> {
  return submissionsRequest<void>(`/api/contacts/${id}`, { method: "DELETE" });
}

export async function listNewsletterSubscriptions(): Promise<NewsletterSubscription[]> {
  return submissionsRequest<NewsletterSubscription[]>("/api/newsletter");
}

export async function updateNewsletterStatus(id: string, status: string): Promise<NewsletterSubscription> {
  return submissionsRequest<NewsletterSubscription>(`/api/newsletter/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function deleteNewsletterSubscription(id: string): Promise<void> {
  return submissionsRequest<void>(`/api/newsletter/${id}`, { method: "DELETE" });
}

export async function listWaitlistEntries(): Promise<WaitlistEntry[]> {
  return submissionsRequest<WaitlistEntry[]>("/api/waitlist");
}

export async function updateWaitlistStatus(id: string, status: string): Promise<WaitlistEntry> {
  return submissionsRequest<WaitlistEntry>(`/api/waitlist/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function deleteWaitlistEntry(id: string): Promise<void> {
  return submissionsRequest<void>(`/api/waitlist/${id}`, { method: "DELETE" });
}

export async function listComments(status?: string): Promise<Comment[]> {
  const qs = status ? `?status=${status}` : "";
  return submissionsRequest<Comment[]>(`/api/cms/comments${qs}`);
}

export async function updateCommentStatus(id: string, status: string): Promise<Comment> {
  return submissionsRequest<Comment>(`/api/cms/comments/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function deleteComment(id: string): Promise<void> {
  return submissionsRequest<void>(`/api/cms/comments/${id}`, { method: "DELETE" });
}

// ─── Me, users, roles, invitations ────────────────────────────────────────────

export async function getMe(): Promise<Me> {
  const data = await submissionsRequest<{ data: Me }>("/api/me");
  return data.data;
}

// ─── Organizations (tenancy T5) ───────────────────────────────────────────────

export async function listOrganizations(): Promise<OrganizationSummary[]> {
  const data = await submissionsRequest<{ data: OrganizationSummary[] }>(
    "/api/organizations"
  );
  return data.data;
}

export async function createOrganization(
  name: string
): Promise<OrganizationSummary> {
  const data = await submissionsRequest<{ data: OrganizationSummary }>(
    "/api/organizations",
    { method: "POST", body: JSON.stringify({ name }) }
  );
  return data.data;
}

export async function getOrganization(id: string): Promise<Organization> {
  const data = await submissionsRequest<{ data: Organization }>(
    `/api/organizations/${id}`
  );
  return data.data;
}

export async function getMyProfile(): Promise<MyProfile> {
  const data = await submissionsRequest<{ data: MyProfile }>("/api/me/profile");
  return data.data;
}

export async function updateMyProfile(patch: {
  display_name?: string | null;
  bio?: string | null;
  author_slug?: string | null;
  job_title?: string | null;
  same_as?: string[];
}): Promise<{
  display_name: string | null;
  bio: string | null;
  author_slug: string | null;
  job_title: string | null;
  same_as: string[];
  byline: string;
  posts_updated: number;
}> {
  const data = await submissionsRequest<{
    data: {
      display_name: string | null;
      bio: string | null;
      author_slug: string | null;
      job_title: string | null;
      same_as: string[];
      byline: string;
      posts_updated: number;
    };
  }>("/api/me/profile", { method: "PATCH", body: JSON.stringify(patch) });
  return data.data;
}

export async function updateOrganization(
  id: string,
  patch: { name?: string; slug?: string; logo?: string | null }
): Promise<Organization> {
  const data = await submissionsRequest<{ data: Organization }>(
    `/api/organizations/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  return data.data;
}

export async function switchOrganization(organizationId: string): Promise<void> {
  await submissionsRequest("/api/organizations/switch", {
    method: "POST",
    body: JSON.stringify({ organization_id: organizationId }),
  });
}

// ─── Personal access tokens (file-based sync) ─────────────────────────────────

export async function listApiTokens(): Promise<ApiToken[]> {
  const data = await request<{ data: ApiToken[] }>("/tokens");
  return data.data;
}

/** Sites a new token for this organization may be limited to (G#21). */
export async function listTokenSiteOptions(organizationId: string): Promise<Site[]> {
  const data = await request<{ data: Site[] }>(
    `/tokens/sites?organization_id=${encodeURIComponent(organizationId)}`
  );
  return data.data;
}

export async function createApiToken(values: {
  name: string;
  /** The organization the token will act on; defaults to the active one. */
  organization_id?: string;
  expires_in_days?: number;
  /** Site slugs to limit the token to; omit or [] for every site in the org. */
  site_scopes?: string[];
}): Promise<ApiTokenCreated> {
  const data = await request<{ data: ApiTokenCreated }>("/tokens", {
    method: "POST",
    body: JSON.stringify(values),
  });
  return data.data;
}

export async function revokeApiToken(id: string): Promise<void> {
  await request<void>(`/tokens/${id}`, { method: "DELETE" });
}

export async function listUsers(params: { q?: string; status?: string } = {}): Promise<CmsUser[]> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.status) qs.set("status", params.status);
  const query = qs.toString();
  const data = await submissionsRequest<{ data: CmsUser[] }>(`/api/users${query ? `?${query}` : ""}`);
  return data.data;
}

export async function updateUser(
  id: string,
  values: { name?: string; status?: string; bio?: string; avatar_url?: string }
): Promise<void> {
  await submissionsRequest(`/api/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(values),
  });
}

export async function deleteUser(id: string): Promise<void> {
  await submissionsRequest<void>(`/api/users/${id}`, { method: "DELETE" });
}

/**
 * Change a member's role. The two axes are independent: omit `role` to only
 * flip the global grant, omit `super_admin` to leave it as it is.
 */
export async function setMemberRole(
  id: string,
  values: { role?: string; super_admin?: boolean }
): Promise<void> {
  await submissionsRequest(`/api/users/${id}/roles`, {
    method: "PUT",
    body: JSON.stringify(values),
  });
}

export async function listRoles(): Promise<Role[]> {
  const data = await submissionsRequest<{ data: Role[] }>("/api/roles");
  return data.data;
}

export async function listInvitations(status?: string): Promise<Invitation[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = await submissionsRequest<{ data: Invitation[] }>(`/api/invitations${query}`);
  return data.data;
}

export async function createInvitation(values: {
  email: string;
  name?: string;
  role_name?: string;
  notes?: string;
}): Promise<Invitation> {
  const data = await submissionsRequest<{ data: Invitation }>("/api/invitations", {
    method: "POST",
    body: JSON.stringify(values),
  });
  return data.data;
}

export async function resendInvitation(id: string): Promise<void> {
  await submissionsRequest(`/api/invitations/${id}`, { method: "POST" });
}

export async function revokeInvitation(id: string): Promise<void> {
  await submissionsRequest<void>(`/api/invitations/${id}`, { method: "DELETE" });
}

// ─── AI style profiles ────────────────────────────────────────────────────────

export async function listStyleProfiles(): Promise<import("@/types/ai").StyleProfileSummary[]> {
  const data = await submissionsRequest<{ data: import("@/types/ai").StyleProfileSummary[] }>("/api/ai/profiles");
  return data.data;
}

export async function createStyleProfile(values: { name: string; scope?: string }): Promise<{ id: string }> {
  const data = await submissionsRequest<{ data: { id: string } }>("/api/ai/profiles", {
    method: "POST",
    body: JSON.stringify(values),
  });
  return data.data;
}

export async function getStyleProfile(id: string): Promise<import("@/types/ai").StyleProfileDetail> {
  const data = await submissionsRequest<{ data: import("@/types/ai").StyleProfileDetail }>(`/api/ai/profiles/${id}`);
  return data.data;
}

export async function updateStyleProfile(
  id: string,
  values: { name?: string; status?: string; guide?: string }
): Promise<void> {
  await submissionsRequest(`/api/ai/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(values),
  });
}

export async function deleteStyleProfile(id: string): Promise<void> {
  await submissionsRequest<void>(`/api/ai/profiles/${id}`, { method: "DELETE" });
}

export async function addStyleSample(
  id: string,
  values: {
    source_type: string;
    url?: string;
    text?: string;
    post_id?: string;
    title?: string;
    liked_notes?: string;
  }
): Promise<void> {
  await submissionsRequest(`/api/ai/profiles/${id}/samples`, {
    method: "POST",
    body: JSON.stringify(values),
  });
}

export async function updateStyleSample(
  id: string,
  sampleId: string,
  values: { liked_notes?: string }
): Promise<void> {
  await submissionsRequest(`/api/ai/profiles/${id}/samples/${sampleId}`, {
    method: "PATCH",
    body: JSON.stringify(values),
  });
}

export async function deleteStyleSample(id: string, sampleId: string): Promise<void> {
  await submissionsRequest<void>(`/api/ai/profiles/${id}/samples/${sampleId}`, { method: "DELETE" });
}

export async function analyzeStyleProfile(id: string): Promise<import("@/types/ai").AnalyzeResult> {
  const data = await submissionsRequest<{ data: import("@/types/ai").AnalyzeResult }>(
    `/api/ai/profiles/${id}/analyze`,
    { method: "POST" }
  );
  return data.data;
}

export async function generateContent(
  values: import("@/types/ai").GenerateRequest
): Promise<import("@/types/ai").GenerateCreateResult | import("@/types/ai").GeneratePolishResult> {
  const data = await submissionsRequest<{
    data: import("@/types/ai").GenerateCreateResult | import("@/types/ai").GeneratePolishResult;
  }>("/api/ai/generate", {
    method: "POST",
    body: JSON.stringify(values),
  });
  return data.data;
}

export async function listGuideSuggestions(
  profileId: string,
  status: "pending" | "all" = "pending"
): Promise<import("@/types/ai").GuideAmendmentSuggestionView[]> {
  const data = await submissionsRequest<{
    data: import("@/types/ai").GuideAmendmentSuggestionView[];
  }>(`/api/ai/profiles/${profileId}/suggestions?status=${status}`);
  return data.data;
}

export async function resolveGuideSuggestion(
  profileId: string,
  suggestionId: string,
  action: "accept" | "reject"
): Promise<{ id: string; status: string }> {
  const data = await submissionsRequest<{ data: { id: string; status: string } }>(
    `/api/ai/profiles/${profileId}/suggestions/${suggestionId}`,
    { method: "POST", body: JSON.stringify({ action }) }
  );
  return data.data;
}

// ─── Build feedback ("My submissions") ────────────────────────────────────────

export type BuildFeedbackItemType = "feedback" | "idea" | "ticket";

export interface BuildFeedbackItem {
  id: string;
  type: BuildFeedbackItemType;
  title: string;
  body: string | null;
  status: string;
  createdAt: string;
  voteCount: number;
  viewerVote: -1 | 0 | 1;
  followed: boolean;
  commentCount: number;
}

export interface BuildFeedbackList {
  items: BuildFeedbackItem[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

export async function listMyBuildFeedback(params: {
  type?: BuildFeedbackItemType;
  status?: string;
  sort?: "date" | "status" | "votes";
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}): Promise<BuildFeedbackList> {
  const qs = new URLSearchParams();
  if (params.type) qs.set("type", params.type);
  if (params.status) qs.set("status", params.status);
  if (params.sort) qs.set("sort", params.sort);
  if (params.order) qs.set("order", params.order);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return submissionsRequest<BuildFeedbackList>(`/api/build-feedback/items${query ? `?${query}` : ""}`);
}

export async function voteBuildFeedback(
  type: BuildFeedbackItemType,
  targetId: string,
  value: -1 | 0 | 1
): Promise<{ voteCount: number; viewerVote: -1 | 0 | 1 }> {
  return submissionsRequest(`/api/build-feedback/vote`, {
    method: "POST",
    body: JSON.stringify({ type, targetId, value }),
  });
}

export async function setBuildFeedbackFollow(
  type: BuildFeedbackItemType,
  targetId: string,
  follow: boolean
): Promise<{ followed: boolean }> {
  return submissionsRequest(`/api/build-feedback/follow`, {
    method: follow ? "POST" : "DELETE",
    body: JSON.stringify({ type, targetId }),
  });
}

export { ApiError };
