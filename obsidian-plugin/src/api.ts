import { requestUrl } from "obsidian";
import type { ServerPost } from "./frontmatter";

export interface CmsSettings {
  baseUrl: string;
  token: string;
  syncFolder: string;
}

export class CmsApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public currentHash?: string
  ) {
    super(message);
    this.name = "CmsApiError";
  }
}

/** POST /api/cms/posts/import — see src/lib/post-sync.ts for the server-side rules. */
export async function importPost(
  settings: CmsSettings,
  raw: string,
  filename: string,
  force = false
): Promise<{ data: ServerPost; created: boolean; warning?: string }> {
  const url = `${settings.baseUrl}/api/cms/posts/import${force ? "?force=true" : ""}`;
  const res = await requestUrl({
    url,
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw, filename }),
    throw: false,
  });

  if (res.status === 409) {
    const body = res.json as { error: string; current_hash: string };
    throw new CmsApiError(409, body.error, body.current_hash);
  }
  if (res.status < 200 || res.status >= 300) {
    const message =
      (res.json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new CmsApiError(res.status, message);
  }
  return res.json as { data: ServerPost; created: boolean; warning?: string };
}

/** GET /api/cms/posts/export — the bulk vault-ready zip. Returns the raw
 * bytes; main.ts unzips with jszip (same lib the CMS's own export route
 * uses server-side). */
export async function exportAllRaw(settings: CmsSettings): Promise<ArrayBuffer> {
  const res = await requestUrl({
    url: `${settings.baseUrl}/api/cms/posts/export`,
    method: "GET",
    headers: { Authorization: `Bearer ${settings.token}` },
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new CmsApiError(res.status, `Export failed: HTTP ${res.status}`);
  }
  return res.arrayBuffer;
}
