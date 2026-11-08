import "server-only";
import crypto from "crypto";
import { executeServiceAction, InteractorError } from "@/lib/interactor";

/**
 * GitHub side of two-way content sync (FILE-BASED-CONTENT-PLAN.md Phase 2),
 * routed entirely through Interactor Core's Service Knowledge Base — same
 * pattern as social publishing (src/lib/social/capabilities.ts): connect via
 * hosted OAuth, execute via /api/v1/execute, this app never holds a GitHub
 * token directly.
 *
 * The capability names below are best-guess (matching GitHub's own official
 * MCP server's tool names, a plausible SKB curation source) and NOT verified
 * against a live SKB — this sandbox has no working Interactor Core
 * credentials to check with. Override via env if they're wrong; nothing
 * else in this module needs to change.
 */

const SERVICE_ID = "github";
const CAPABILITY_GET_FILE =
  process.env.GITHUB_CAPABILITY_GET_FILE || "get_file_contents";
const CAPABILITY_PUT_FILE =
  process.env.GITHUB_CAPABILITY_PUT_FILE || "create_or_update_file_contents";

export interface GithubFileRef {
  repo: string; // "owner/repo"
  branch: string;
  path: string;
  externalUserId: string;
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Malformed repo "${repo}" — expected "owner/repo"`);
  return { owner, repo: name };
}

/** Fetch a file's current content + sha (sha is required to update an existing file). */
export async function getFileFromGithub(
  ref: GithubFileRef
): Promise<{ content: string; sha: string } | null> {
  const { owner, repo } = splitRepo(ref.repo);
  try {
    const result = await executeServiceAction<{
      content?: string;
      sha?: string;
      encoding?: string;
    }>({
      serviceId: SERVICE_ID,
      capabilityName: CAPABILITY_GET_FILE,
      externalUserId: ref.externalUserId,
      args: { owner, repo, path: ref.path, ref: ref.branch },
    });
    if (!result.data.content || !result.data.sha) return null;
    const encoded = result.data.content.replace(/\n/g, "");
    return {
      content: Buffer.from(encoded, "base64").toString("utf-8"),
      sha: result.data.sha,
    };
  } catch (e) {
    if (e instanceof InteractorError && e.status === 404) return null;
    throw e;
  }
}

/** Create the file if it doesn't exist, update it (with the required sha) if it does. */
export async function putFileToGithub(
  ref: GithubFileRef,
  content: string,
  message: string
): Promise<{ sha: string }> {
  const { owner, repo } = splitRepo(ref.repo);
  const existing = await getFileFromGithub(ref);

  const result = await executeServiceAction<{ content?: { sha?: string } }>({
    serviceId: SERVICE_ID,
    capabilityName: CAPABILITY_PUT_FILE,
    externalUserId: ref.externalUserId,
    args: {
      owner,
      repo,
      path: ref.path,
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      branch: ref.branch,
      ...(existing && { sha: existing.sha }),
    },
  });

  const sha = result.data.content?.sha;
  if (!sha) throw new Error("GitHub did not return a sha for the written file");
  return { sha };
}

// --- Inbound webhook (direct from GitHub — independent of Core; a repo
// webhook is configured on github.com pointing straight at our endpoint,
// same as any other GitHub App/webhook integration) -------------------------

/**
 * Verify GitHub's `X-Hub-Signature-256` header: `sha256=<hex hmac>` of the
 * raw body using the webhook secret configured on the repo. This is GitHub's
 * own long-stable, publicly documented scheme — unlike the SKB capability
 * names above, there's no ambiguity here.
 */
export function verifyGithubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface GithubPushEvent {
  ref: string;
  after: string;
  commits: { added: string[]; modified: string[]; removed: string[] }[];
}

/** Every content/posts/*.md path touched by a push, added+modified minus removed, deduped. */
export function changedMarkdownPaths(event: GithubPushEvent, pathPrefix: string): string[] {
  const touched = new Set<string>();
  const removed = new Set<string>();
  for (const commit of event.commits) {
    for (const p of [...commit.added, ...commit.modified]) touched.add(p);
    for (const p of commit.removed) removed.add(p);
  }
  return [...touched].filter(
    (p) => p.startsWith(pathPrefix) && p.endsWith(".md") && !removed.has(p)
  );
}
