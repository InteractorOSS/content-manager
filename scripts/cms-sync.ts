#!/usr/bin/env tsx
// Sync CMS posts to/from local Markdown files — the CLI rung of the desktop
// sync ladder (see FILE-BASED-CONTENT-PLAN.md Phase 3). Wraps the Phase 1
// export/import API; this is the actual sync engine, meant to be wrapped by
// an Obsidian plugin or a native tray app later without rewriting the logic.
//
// Auth: a personal access token from /settings/tokens, as CMS_API_TOKEN
// (put it in .env.local — it's a personal secret, never committed).
// Base URL: CMS_API_BASE, defaults to http://localhost:4021.
//
// Usage:
//   npm run cms:pull                          # download all posts into content/posts/
//   npm run cms:pull -- --dir my-vault --status draft
//   npm run cms:push -- content/posts         # import every changed .md file back
//   npm run cms:push -- content/posts/one-post.md --force

import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { parsePostFile, serializePostFile, type ExportablePost } from "../src/lib/post-frontmatter";

// ─── Pure core (unit-testable) ────────────────────────────────────────────────

export interface SyncConfig {
  baseUrl: string;
  token: string;
}

export function loadSyncConfig(env: NodeJS.ProcessEnv): SyncConfig {
  const token = env.CMS_API_TOKEN;
  if (!token) {
    throw new Error(
      "CMS_API_TOKEN is not set — create one at /settings/tokens and put it in .env.local"
    );
  }
  return { baseUrl: env.CMS_API_BASE ?? "http://localhost:4021", token };
}

export function parseArgs(argv: string[]): {
  positional: string[];
  dir?: string;
  status?: string;
  force: boolean;
} {
  const positional: string[] = [];
  let dir: string | undefined;
  let status: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") dir = argv[++i];
    else if (arg === "--status") status = argv[++i];
    else if (arg === "--force") force = true;
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  return { positional, dir, status, force };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

async function pull(fetchFn: FetchFn, cfg: SyncConfig, dir: string, status?: string) {
  const url = new URL("/api/cms/posts/export", cfg.baseUrl);
  if (status) url.searchParams.set("status", status);

  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);

  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });

  let count = 0;
  for (const [filePath, entry] of Object.entries(zip.files)) {
    if (entry.dir || !filePath.endsWith(".md")) continue;
    const dest = path.join(dir, path.basename(filePath));
    fs.writeFileSync(dest, await entry.async("string"));
    count++;
  }
  process.stdout.write(`[cms-sync] pulled ${count} post(s) into ${dir}\n`);
}

function collectMarkdownFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(target, f));
}

async function pushOne(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  filePath: string,
  force: boolean
): Promise<void> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const filename = path.basename(filePath);
  const url = new URL("/api/cms/posts/import", cfg.baseUrl);
  if (force) url.searchParams.set("force", "true");

  const res = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, filename }),
  });

  if (res.status === 409) {
    const body = (await res.json()) as { error: string; current_hash: string };
    process.stdout.write(
      `[cms-sync] CONFLICT ${filename} — ${body.error}. Someone else changed this post; ` +
        `re-pull it to see their edit, or re-run with --force to overwrite it.\n`
    );
    return;
  }
  if (!res.ok) {
    process.stdout.write(`[cms-sync] FAILED  ${filename} — ${res.status} ${await res.text()}\n`);
    return;
  }

  const body = (await res.json()) as {
    data: Omit<ExportablePost, "published_at"> & { published_at: string | null };
    created: boolean;
    warning?: string;
  };
  // Verify the file still parses (surfaces a clear error instead of a silent
  // partial sync if something upstream produced malformed frontmatter).
  parsePostFile(raw);
  // Write the server-assigned id/slug/content_hash back into the file so the
  // next push has an accurate baseline (D3 — the file becomes self-describing
  // after its first sync). The API returns dates as ISO strings; the shared
  // serializer expects Date, matching its other caller (the export route).
  fs.writeFileSync(
    filePath,
    serializePostFile({
      ...body.data,
      published_at: body.data.published_at ? new Date(body.data.published_at) : null,
    })
  );

  const verb = body.created ? "created" : "updated";
  process.stdout.write(`[cms-sync] ${verb.padEnd(7)} ${filename}\n`);
  if (body.warning) process.stdout.write(`[cms-sync]   warning: ${body.warning}\n`);
}

async function push(fetchFn: FetchFn, cfg: SyncConfig, target: string, force: boolean) {
  const files = collectMarkdownFiles(target);
  if (files.length === 0) {
    process.stdout.write(`[cms-sync] no .md files found at ${target}\n`);
    return;
  }
  for (const file of files) {
    await pushOne(fetchFn, cfg, file, force);
  }
}

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, dir, status, force } = parseArgs(rest);

  if (command !== "pull" && command !== "push") {
    process.stderr.write("[cms-sync] Usage: npm run cms:pull | npm run cms:push -- <file-or-dir>\n");
    process.exit(1);
  }

  let cfg: SyncConfig;
  try {
    cfg = loadSyncConfig(process.env);
  } catch (err) {
    process.stderr.write(`[cms-sync] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    if (command === "pull") {
      await pull(fetch, cfg, dir ?? "content/posts", status);
    } else {
      const target = positional[0] ?? "content/posts";
      await push(fetch, cfg, target, force);
    }
  } catch (err) {
    process.stderr.write(`[cms-sync] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "cms-sync.ts"))) {
  void run();
}
