import type {
  SocialChannel,
  SocialPost,
  SocialCampaign,
  ConnectableService,
  ChannelAccountOption,
  SocialPostTarget,
  ManualQueueItem,
} from "@/types/social";

class SocialApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = "SocialApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/social${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    const message =
      typeof body === "object" && body !== null && "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new SocialApiError(response.status, message, body);
  }
  const json = (await response.json()) as { data: T };
  return json.data;
}

// --- Services & channels -----------------------------------------------------

export function listConnectableServices() {
  return request<ConnectableService[]>("/services");
}

export function listChannels() {
  return request<SocialChannel[]>("/channels");
}

export function connectChannel(input: {
  service_id?: string;
  account_id?: string;
  account_name?: string;
  /** Sign in again for an existing connection instead of starting a new one. */
  reconnect_channel_id?: string;
}) {
  return request<{
    channel: SocialChannel;
    authorization_url: string;
    flow_id: string;
  }>("/channels", { method: "POST", body: JSON.stringify(input) });
}

export function updateChannel(
  id: string,
  input: { account_name?: string; account_id?: string; default_target?: boolean }
) {
  return request<SocialChannel>(`/channels/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** The accounts a connected channel can publish to (its Pages, its Slack
 *  channels). `supported: false` means this service's account is typed, not
 *  picked. */
export function listChannelAccounts(id: string) {
  return request<{ supported: boolean; accounts: ChannelAccountOption[] }>(
    `/channels/${id}/accounts`
  );
}

/** Make a connection post to exactly these places (its Pages, channels, subreddits). */
export function setChannelDestinations(
  id: string,
  accounts: { id: string; name?: string }[]
) {
  return request<SocialChannel[]>(`/channels/${id}/destinations`, {
    method: "PUT",
    body: JSON.stringify({ accounts }),
  });
}

/** Remove one place, or with `scope: "connection"` the whole sign-in and
 *  everywhere it posts. */
export function disconnectChannel(id: string, scope?: "connection") {
  return request<{ deleted: boolean }>(
    `/channels/${id}${scope ? `?scope=${scope}` : ""}`,
    { method: "DELETE" }
  );
}

/**
 * G#27: a manual-delivery channel — no API access exists for it at all (e.g.
 * a personal Facebook profile), so there is no OAuth flow: the channel is
 * created active immediately.
 */
export function connectManualChannel(input: {
  service_id: string;
  service_name?: string;
  account_id?: string;
  account_name?: string;
}) {
  return request<{ channel: SocialChannel }>("/channels", {
    method: "POST",
    body: JSON.stringify({ ...input, delivery_mode: "manual" }),
  });
}

// --- Manual delivery queue (G#27) ------------------------------------------

export function listManualQueue() {
  return request<ManualQueueItem[]>("/manual");
}

export function markManualPosted(
  targetId: string,
  input: { external_url?: string; external_post_id?: string }
) {
  return request<SocialPostTarget>(`/manual/${targetId}/mark-posted`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// --- Posts --------------------------------------------------------------------

export interface SocialPostInput {
  body?: string;
  /** What follows the body: thread replies, then at most one first comment. */
  parts?: import("@/lib/social/parts").SocialPart[];
  link?: string | null;
  /** Media library items; the server fills url/type from each file. */
  media?: { media_id: string; alt?: string }[];
  /** channel_id -> that channel's own media; null = use `media`. */
  media_overrides?: Record<string, { media_id: string; alt?: string }[] | null>;
  scheduled_at?: string | null;
  campaign_id?: string | null;
  channel_ids?: string[];
  body_overrides?: Record<string, string>;
  status?: "draft" | "scheduled" | "archived";
}

export function listSocialPosts(filters?: {
  status?: string;
  channel_id?: string;
  campaign_id?: string;
  from?: string;
  to?: string;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return request<SocialPost[]>(`/posts${qs ? `?${qs}` : ""}`);
}

export function getSocialPost(id: string) {
  return request<SocialPost>(`/posts/${id}`);
}

export function createSocialPost(input: SocialPostInput) {
  return request<SocialPost>("/posts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSocialPost(id: string, input: SocialPostInput) {
  return request<SocialPost>(`/posts/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteSocialPost(id: string) {
  return request<{ deleted: boolean }>(`/posts/${id}`, { method: "DELETE" });
}

export function publishSocialPostNow(id: string) {
  return request<SocialPost>(`/posts/${id}/publish`, { method: "POST" });
}

/** Send this post to one channel again, now. Returns the whole post back. */
export function retrySocialPostTarget(postId: string, targetId: string) {
  return request<SocialPost>(`/posts/${postId}/targets/${targetId}/retry`, {
    method: "POST",
  });
}

export function socialWorkflowAction(
  id: string,
  action: "submit" | "approve" | "reject",
  comments?: string
) {
  return request<SocialPost>(`/posts/${id}/workflow`, {
    method: "POST",
    body: JSON.stringify({ action, comments }),
  });
}

export function runSchedulerNow() {
  return request<{ processed: number }>("/scheduler", { method: "POST" });
}

// --- Campaigns ------------------------------------------------------------------

export function listCampaigns() {
  return request<SocialCampaign[]>("/campaigns");
}

export function createCampaign(input: {
  name: string;
  color?: string;
  description?: string;
  recycle?: boolean;
}) {
  return request<SocialCampaign>("/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCampaign(
  id: string,
  input: Partial<{
    name: string;
    color: string | null;
    description: string | null;
    recycle: boolean;
  }>
) {
  return request<SocialCampaign>(`/campaigns/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteCampaign(id: string) {
  return request<{ deleted: boolean }>(`/campaigns/${id}`, {
    method: "DELETE",
  });
}
