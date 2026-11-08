#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Mark an engine task DELIVERED from the terminal (engine:done) — the "delivered"
 * twin of engine:cancel.
 *
 * Marks a specific engine task `done` (runtimeState) via the daemon-token complete
 * endpoint (`POST /api/v1/me/engine/complete`). For work that shipped via a
 * hand-driven PR and so never advanced through the engine review flow, leaving its
 * task stuck non-terminal (the #496/#497/#502 stale-backlog case). Uses the server's
 * operator override — `done` isn't reachable from `backlog` in the normal transition
 * map (unlike `cancelled`) — but an already-terminal task is refused (409).
 *
 * Resolves the identifier like engine:cancel — `#N` / slug / title fragment — and
 * accepts a raw task UUID. Credential + config shared via `.build/.sync` (or legacy `.tasks/.sync`) +
 * PM_DAEMON_TOKEN.
 *
 * An optional `--reason` is recorded on the completion audit event
 * (TaskLifecycleEvent, action `completed`); omitted → server default "delivered by
 * operator".
 *
 * Usage:
 *   npm run engine:done -- 42                          # by display number
 *   npm run engine:done -- <uuid>                      # by raw task id
 *   npm run engine:done -- 42 --reason "shipped via #1095"
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { isUuid, buildCancelBody, parseReasonArg, type CancelResult } from "./engine-cancel";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

// The request body shape is identical to cancel (projectId + taskId|identifier +
// optional reason), so reuse buildCancelBody / parseReasonArg / isUuid rather than
// duplicate them — only the endpoint + the target state differ.
export { isUuid, buildCancelBody, parseReasonArg };
export type DoneResult = CancelResult;

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST the completion. Returns the updated task (`{ data }` envelope). Throws with
 * the server's `message` on a non-OK response (e.g. 409 for an already-terminal task).
 */
export async function completeEngineTask(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  body: Record<string, string>,
): Promise<DoneResult> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Complete failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: DoneResult } | null;
  if (!parsed?.data) {
    throw new Error(`Complete succeeded (${res.status}) but the response had no task data`);
  }
  return parsed.data;
}

/** Success message: the delivered `#N`/title and its new runtime state. */
export function renderDone(task: DoneResult): string {
  const n = task.displayNumber != null ? `#${task.displayNumber} ` : "";
  return `[engine-done] Delivered ${n}${task.title} — ${task.id} (now ${task.runtimeState}).\n`;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const reason = parseReasonArg(argv);
  // First positional, skipping `--flag`s and a bare `--reason`'s value.
  let identifier: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reason") {
      i++;
      continue;
    }
    if (argv[i].startsWith("--")) continue;
    identifier = argv[i];
    break;
  }

  if (!identifier) {
    process.stderr.write("[engine-done] Usage: npm run engine:done -- <#N | slug | uuid | title-fragment> [--reason <text>]\n");
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-done] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-done] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let task: DoneResult;
  try {
    task = await completeEngineTask(fetch, cfg, token, buildCancelBody(identifier, cfg.projectId, reason));
  } catch (err) {
    process.stderr.write(`[engine-done] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(renderDone(task));
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-done.ts"))) {
  void run();
}
