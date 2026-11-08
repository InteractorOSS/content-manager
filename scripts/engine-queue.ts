#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Promote an engine task into the runnable queue from the terminal (engine:queue).
 *
 * Flips a specific engine task's runtimeState → `queued` via the daemon-token
 * endpoint (`POST /api/v1/me/engine/queue`), so a task parked in `backlog` (#401)
 * becomes fleet-claimable — the terminal counterpart to clicking "Add to queue".
 * The inverse of engine:create's default (which parks new tasks in backlog).
 *
 * Resolves the identifier the same way as engine:work — `#N` / slug / title
 * fragment — and also accepts a raw task UUID (sent directly as `taskId`, since
 * the server resolver doesn't match a bare id). Credential + config are shared
 * with engine-claim/engine-work: `.build/.sync` (or legacy `.tasks/.sync`) + PM_DAEMON_TOKEN.
 *
 * Usage:
 *   npm run engine:queue -- 42                 # by display number
 *   npm run engine:queue -- my-task-slug       # by slug
 *   npm run engine:queue -- <uuid>             # by raw task id
 *   npm run engine:queue -- "parked title"     # by title fragment
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a bare task UUID — sent as `taskId` since the resolver can't match it. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export interface QueueResult {
  id: string;
  displayNumber: number | null;
  title: string;
  runtimeState: string;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A raw UUID goes as `taskId` (resolver can't match it); anything else as `identifier`. */
export function buildQueueBody(identifier: string, projectId: string): Record<string, string> {
  return isUuid(identifier) ? { taskId: identifier, projectId } : { identifier, projectId };
}

/**
 * POST the promote. Returns the updated task (reads the `{ data }` envelope).
 * Throws with the server's `message` on a non-OK response (e.g. a 409 for a
 * task with no legal `→queued` transition, like one already running/done).
 */
export async function queueEngineTask(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  body: Record<string, string>,
): Promise<QueueResult> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/queue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Queue failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: QueueResult } | null;
  if (!parsed?.data) {
    throw new Error(`Queue succeeded (${res.status}) but the response had no task data`);
  }
  return parsed.data;
}

/** Success message: the promoted `#N`/title and its new runtime state. */
export function renderQueued(task: QueueResult): string {
  const n = task.displayNumber != null ? `#${task.displayNumber} ` : "";
  return `[engine-queue] Queued ${n}${task.title} — ${task.id} (now ${task.runtimeState}; an idle fleet can claim it).\n`;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();
  const identifier = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;

  if (!identifier) {
    process.stderr.write(
      "[engine-queue] Usage: npm run engine:queue -- <#N | slug | uuid | title-fragment>\n",
    );
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-queue] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-queue] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let task: QueueResult;
  try {
    task = await queueEngineTask(fetch, cfg, token, buildQueueBody(identifier, cfg.projectId));
  } catch (err) {
    process.stderr.write(`[engine-queue] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(renderQueued(task));
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-queue.ts"))) {
  void run();
}
