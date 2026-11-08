// Client for the Phase 2 git content-sync connect flow (mirrors social-api.ts).

export interface ContentSyncConnection {
  id: string;
  service_id: string;
  repo: string;
  branch: string;
  status: string;
  connected_by: { id: string; name: string | null; email: string } | null;
  inserted_at: string;
  updated_at: string;
}

class ContentSyncApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ContentSyncApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/content-sync${path}`, {
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
    throw new ContentSyncApiError(response.status, message);
  }
  const json = (await response.json()) as { data: T };
  return json.data;
}

export function getContentSyncConnection() {
  return request<ContentSyncConnection | null>("/connect");
}

export async function connectContentSync(values: { repo: string; branch?: string }) {
  return request<{ connection: ContentSyncConnection; authorization_url: string }>(
    "/connect",
    { method: "POST", body: JSON.stringify(values) }
  );
}

export async function disconnectContentSync() {
  const res = await fetch("/api/content-sync/connect", { method: "DELETE" });
  if (!res.ok) throw new ContentSyncApiError(res.status, `HTTP ${res.status}`);
}
