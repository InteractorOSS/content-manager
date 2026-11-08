import "server-only";
import crypto from "crypto";
import { env } from "@/lib/env";

/**
 * Server-side client for the Interactor Core API (core.interactor.com).
 *
 * Auth model: OAuth2 client-credentials App Token from the account server
 * (15-minute JWT, cached in-process). Every user-scoped call passes our local
 * user id as `external_user_id` — Interactor stores third-party credentials
 * (Facebook, Slack, ...) per external user and executes service actions with
 * them, so this app never touches provider tokens directly.
 */

const CORE = () => `${env.INTERACTOR_CORE_URL}/api/v1`;

export class InteractorError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
    /**
     * How long Core asked us to wait, in seconds, when the refusal carried a
     * `Retry-After` header. The publisher uses it verbatim instead of guessing
     * a backoff — a rate limit Core knows the length of beats an exponential
     * curve we invented. Undefined when the header was absent or unparseable.
     */
    public retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "InteractorError";
  }
}

/**
 * Seconds to wait per a `Retry-After` header, which RFC 9110 allows in two
 * spellings: a delay in seconds, or an HTTP date. Anything else — or a value
 * in the past — yields undefined so the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.ceil((at - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

// --- App token (client credentials), cached until shortly before expiry ----

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const clientId = env.INTERACTOR_API_CLIENT_ID || env.INTERACTOR_CLIENT_ID;
  const clientSecret =
    env.INTERACTOR_API_CLIENT_SECRET || env.INTERACTOR_CLIENT_SECRET;

  const res = await fetch(`${env.ACCOUNT_SERVER_URL}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new InteractorError(
      res.status,
      `Failed to obtain Interactor app token (${res.status})`,
      await res.text().catch(() => undefined)
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
  };
  return cachedToken.token;
}

async function coreFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getAppToken();
  const res = await fetch(`${CORE()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } } | null)?.error?.message ??
      `Interactor Core request failed (${res.status} ${path})`;
    throw new InteractorError(
      res.status,
      message,
      json,
      parseRetryAfter(res.headers.get("retry-after"))
    );
  }
  return json as T;
}

// --- Service catalog (Service Knowledge Base, proxied by Core) --------------

export interface SkbService {
  id: string;
  slug?: string;
  name: string;
  display_name?: string;
  description?: string;
  verification_status?: string;
}

export async function searchServices(query: string, limit = 20) {
  const res = await coreFetch<{
    data?: SkbService[] | { results?: SkbService[] };
    services?: SkbService[];
  }>("/service-knowledge-base/services/search", {
    method: "POST",
    body: JSON.stringify({ query, limit }),
  });
  // Core wraps the hits as {data: {results: [...]}}; older shapes put the
  // list directly under data or services.
  if (Array.isArray(res.data)) return res.data;
  return res.data?.results ?? res.services ?? [];
}

/**
 * Whether a service exists in the catalog, by its exact slug.
 *
 * Search is the wrong question for this: it is a semantic match, so
 * "facebook-graph-api" finds nothing and "linkedin" finds an unrelated
 * service above the real one. A 404 here is a definite "not in the catalog";
 * any other failure is rethrown so the caller can tell "absent" from "Core
 * could not say".
 */
export async function serviceExists(slug: string): Promise<boolean> {
  try {
    await coreFetch(`/service-knowledge-base/services/${encodeURIComponent(slug)}`);
    return true;
  } catch (err) {
    if (err instanceof InteractorError && err.status === 404) return false;
    throw err;
  }
}

export async function getServiceCapabilities(serviceId: string) {
  const res = await coreFetch<{ data?: unknown[] }>(
    `/service-knowledge-base/services/${encodeURIComponent(serviceId)}/capabilities`
  );
  return res.data ?? [];
}

// --- Credentials & hosted OAuth connect flow --------------------------------

export interface InteractorCredential {
  id: string;
  service_id?: string;
  service?: string;
  /**
   * The Core identity this credential is stored under. Optional because Core
   * does not promise it on a credential body — when it is absent, ownership is
   * confirmed the other way round, via {@link listCredentials}.
   */
  external_user_id?: string;
  status?: string;
  scopes?: string[];
  expires_at?: string;
  metadata?: Record<string, unknown>;
  identity?: Record<string, unknown>;
}

export async function initiateOAuth(params: {
  serviceId: string;
  externalUserId: string;
  scopes?: string[];
  successRedirectUrl: string;
  metadata?: Record<string, unknown>;
}) {
  const res = await coreFetch<{
    data: { flow_id: string; authorization_url: string; state?: string };
  }>("/oauth/initiate", {
    method: "POST",
    body: JSON.stringify({
      service_id: params.serviceId,
      external_user_id: params.externalUserId,
      scopes: params.scopes,
      success_redirect_url: params.successRedirectUrl,
      metadata: params.metadata,
    }),
  });
  return res.data;
}

export async function listCredentials(externalUserId: string) {
  const res = await coreFetch<{ data?: InteractorCredential[] }>(
    `/credentials?external_user_id=${encodeURIComponent(externalUserId)}`
  );
  return res.data ?? [];
}

export async function getCredential(credentialId: string) {
  const res = await coreFetch<{ data?: InteractorCredential }>(
    `/credentials/${encodeURIComponent(credentialId)}`
  );
  return res.data ?? null;
}

export async function deleteCredential(credentialId: string) {
  await coreFetch(`/credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
  });
}

// --- Action execution --------------------------------------------------------

export interface ExecuteResult<T = Record<string, unknown>> {
  data: T;
  metadata?: {
    execution_type?: string;
    executed_at?: string;
    latency_ms?: number;
    /**
     * The provider's own response headers, relayed by Core (G#44). Some
     * networks answer a create with the new id only in a header — LinkedIn's
     * `x-restli-id` — so without these a post has no external URL. Absent
     * from a Core that predates G#44; read it through {@link responseHeaders}.
     */
    response_headers?: unknown;
  };
}

/**
 * Which action to run, and as which credential.
 *
 * `credentialId` names the exact Core credential (G#44). Without it Core uses
 * the identity's default credential for the service, which is unambiguous
 * only while the identity holds one — a reconnect can leave an older one
 * behind. Optional: callers with no stored credential keep the old behaviour,
 * and a Core that predates G#44 ignores the extra key.
 */
export interface ExecuteParams {
  serviceId: string;
  capabilityName: string;
  args: Record<string, unknown>;
  externalUserId: string;
  credentialId?: string | null;
}

function executeBody(params: ExecuteParams): Record<string, unknown> {
  return {
    execution_type: "service_action",
    service_id: params.serviceId,
    capability_name: params.capabilityName,
    arguments: params.args,
    external_user_id: params.externalUserId,
    ...(params.credentialId ? { credential_id: params.credentialId } : {}),
  };
}

/** Execute a service action (e.g. facebook-graph-api/publish_page_post) using
 * the third-party credential Interactor holds for `externalUserId`. */
export async function executeServiceAction<T = Record<string, unknown>>(
  params: ExecuteParams
): Promise<ExecuteResult<T>> {
  return coreFetch<ExecuteResult<T>>("/execute", {
    method: "POST",
    body: JSON.stringify(executeBody(params)),
  });
}

/** Raw bytes for a provider upload (an image for X's `upload_media`, the PUT
 * leg of LinkedIn's image upload). */
export interface BinaryBody {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Execute an action whose request body is a file rather than JSON arguments.
 *
 * /execute is a JSON endpoint, so the bytes travel base64-encoded in
 * `binary_body` beside the usual arguments (which still fill the path and
 * query placeholders), and Core sends them decoded as the provider request's
 * body with the given content type. This is the one place that wire shape is
 * written: G#44 had not shipped in Core when it was built, so if Core settles
 * on a different spelling, only this function changes.
 */
export async function executeServiceUpload<T = Record<string, unknown>>(
  params: ExecuteParams & { body: BinaryBody }
): Promise<ExecuteResult<T>> {
  return coreFetch<ExecuteResult<T>>("/execute", {
    method: "POST",
    body: JSON.stringify({
      ...executeBody(params),
      binary_body: {
        content_type: params.body.contentType,
        data_base64: Buffer.from(params.body.bytes).toString("base64"),
      },
    }),
  });
}

/**
 * The provider response headers on an execute result, as a map keyed by
 * lowercase name. Core may relay them as a map whose values are a string or a
 * list (a header can repeat), or as a list of `[name, value]` pairs; repeats
 * are joined with ", ", the HTTP rule for combining them. Anything else —
 * including a Core that predates G#44 and sends none — is an empty map,
 * never a throw: a header is extra information, not a reason to fail a post
 * the provider already accepted.
 */
export function responseHeaders(
  result: Pick<ExecuteResult<unknown>, "metadata">
): Record<string, string> {
  const raw = result.metadata?.response_headers;
  const out: Record<string, string> = {};
  const add = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || !name) return;
    const values = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string | number => typeof v === "string" || typeof v === "number"
    );
    if (values.length === 0) return;
    const key = name.toLowerCase();
    const joined = values.map(String).join(", ");
    out[key] = out[key] ? `${out[key]}, ${joined}` : joined;
  };
  if (Array.isArray(raw)) {
    for (const pair of raw) if (Array.isArray(pair)) add(pair[0], pair[1]);
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) add(name, value);
  }
  return out;
}

// --- Webhook signature verification ------------------------------------------

/**
 * Whether a signing secret is configured at all.
 *
 * Verification can no longer be skipped, so an unset `INTERACTOR_WEBHOOK_SECRET`
 * means the receiver is *misconfigured* rather than open. The route asks this
 * first and answers 503 instead of the 401 a forged delivery gets, so an
 * operator can tell "we never set the secret" from "someone is forging
 * deliveries" by the response alone.
 */
export function webhookSigningConfigured(): boolean {
  return Boolean(env.INTERACTOR_WEBHOOK_SECRET);
}

/** Verify `X-Interactor-Signature` (HMAC-SHA256 of "{timestamp}.{body}"). */
export function verifyWebhookSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  const secret = env.INTERACTOR_WEBHOOK_SECRET;
  // Fail closed, in every environment. This used to return true when no
  // secret was configured, which made an unauthenticated public route accept
  // any unsigned body and turn it into a channel status write — anyone who
  // could reach the host could forge `credential.revoked` and disable a
  // tenant's channels. Local webhook testing needs a secret in .env.local.
  if (!secret) return false;
  if (!timestamp || !signature) return false;
  const ageMs = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(ageMs) || ageMs > 5 * 60_000) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}
