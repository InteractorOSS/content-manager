import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { tenantDb } from "@/lib/tenant-db";
import { loadActor } from "@/lib/rbac";
import { computeContentHash } from "@/lib/markdown";
import { parsePostFile } from "@/lib/post-frontmatter";
import { applyPostImport } from "@/lib/post-sync";
import {
  changedMarkdownPaths,
  getFileFromGithub,
  verifyGithubWebhookSignature,
  type GithubPushEvent,
} from "@/lib/github-sync";

const PATH_PREFIX = "content/posts/";

/**
 * Inbound half of Phase 2 two-way sync — a GitHub repo webhook (configured
 * directly on github.com, independent of the SKB/OAuth connection used for
 * outbound writes) POSTs push events here. Public route (added to
 * src/proxy.ts's allowlist), authenticated by GitHub's own
 * X-Hub-Signature-256 HMAC instead of a session.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Content sync webhook not configured" }, { status: 500 });
  }

  const rawBody = await req.text();
  if (!verifyGithubWebhookSignature(rawBody, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventType = req.headers.get("x-github-event");
  if (eventType === "ping") {
    return NextResponse.json({ pong: true });
  }
  if (eventType !== "push") {
    return NextResponse.json({ ignored: eventType });
  }

  let event: GithubPushEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const connection = await prisma.contentSyncConnection.findFirst({
    where: { status: "active" },
    orderBy: { inserted_at: "desc" },
  });
  if (!connection?.credential_id) {
    return NextResponse.json({ error: "No active content sync connection" }, { status: 409 });
  }

  const botEmail = process.env.GITHUB_SYNC_BOT_EMAIL;
  if (!botEmail) {
    return NextResponse.json(
      { error: "GITHUB_SYNC_BOT_EMAIL is not configured — no actor to apply the sync as" },
      { status: 500 }
    );
  }
  const actor = await loadActor({ email: botEmail });
  if (!actor) {
    return NextResponse.json({ error: `GITHUB_SYNC_BOT_EMAIL "${botEmail}" is not a valid user` }, { status: 500 });
  }
  const db = tenantDb(actor.organizationId);

  const paths = changedMarkdownPaths(event, PATH_PREFIX);
  const results: { path: string; outcome: string }[] = [];

  for (const path of paths) {
    try {
      const file = await getFileFromGithub({
        repo: connection.repo,
        branch: connection.branch,
        path,
        externalUserId: connection.external_user_id,
      });
      if (!file) {
        results.push({ path, outcome: "not_found" });
        continue;
      }

      // Loop prevention: this push may just be an echo of our own outbound
      // write (see src/lib/content-sync-scheduler.ts). Compare the fetched
      // file's BODY hash (not the whole file — frontmatter varies run to
      // run) against the post's canonical content_hash; if they already
      // match, there's nothing to do.
      const filename = path.slice(PATH_PREFIX.length);
      const { frontmatter, body } = parsePostFile(file.content);
      const existing = frontmatter.id
        ? await db.post.findUnique({ where: { id: frontmatter.id } })
        : await db.post.findFirst({ where: { slug: frontmatter.slug || filename.replace(/\.mdx?$/i, "") } });
      if (existing && existing.content_hash === computeContentHash(body)) {
        results.push({ path, outcome: "unchanged" });
        continue;
      }

      const result = await applyPostImport({
        raw: file.content,
        filename,
        actor,
        db,
        onConflict: "flag",
      });
      results.push({ path, outcome: result.kind });
    } catch (err) {
      results.push({ path, outcome: "error" });
      console.error(`[content-sync-webhook] failed to ingest ${path}:`, err);
    }
  }

  return NextResponse.json({ received: true, results });
}
