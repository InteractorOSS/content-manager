#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cancel an engine task from the terminal (engine:cancel).
 *
 * Marks a specific engine task `cancelled` (runtimeState) via the daemon-token
 * cancel endpoint (`POST /api/v1/me/engine/cancel`), so a stuck/orphaned
 * `running` task or an abandoned queued/blocked one can be retired without the
 * browser-only v2 transition route. The terminal counterpart to clicking
 * "Cancel" in the UI.
 *
 * Resolves the identifier the same way as engine:work — `#N` / slug / title
 * fragment — and also accepts a raw task UUID (sent directly as `taskId`, since
 * the server resolver doesn't match a bare id). Credential + config are shared
 * with engine-claim/engine-work: `.build/.sync` (or legacy `.tasks/.sync`) + PM_DAEMON_TOKEN.
 *
 * An optional `--reason` is recorded on the task's cancellation audit event
 * (TaskLifecycleEvent); when omitted the server defaults it to "cancelled by
 * operator".
 *
 * Usage:
 *   npm run engine:cancel -- 42                          # by display number
 *   npm run engine:cancel -- my-task-slug                # by slug
 *   npm run engine:cancel -- <uuid>                      # by raw task id
 *   npm run engine:cancel -- "stuck title"               # by title fragment
 *   npm run engine:cancel -- 42 --reason "superseded"    # with an audit reason
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a bare task UUID — sent as `taskId` since the resolver can't match it. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export interface CancelResult {
  id: string;
  displayNumber: number | null;
  title: string;
  runtimeState: string;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A raw UUID goes as `taskId` (resolver can't match it); anything else as `identifier`.
 *  A non-blank `reason` is forwarded so the server records it on the cancellation audit. */
export function buildCancelBody(
  identifier: string,
  projectId: string,
  reason?: string,
): Record<string, string> {
  const body: Record<string, string> = { projectId };
  if (isUuid(identifier)) body.taskId = identifier;
  else body.identifier = identifier;
  if (reason && reason.trim()) body.reason = reason.trim();
  return body;
}

/** Extract an optional `--reason <text>` / `--reason=<text>` flag from argv. */
export function parseReasonArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reason") return argv[i + 1];
    if (a.startsWith("--reason=")) return a.slice("--reason=".length);
  }
  return undefined;
}

/**
 * POST the cancel. Returns the updated task (reads the `{ data }` envelope).
 * Throws with the server's `message` on a non-OK response (e.g. a 409 for a
 * task that is already terminal).
 */
export async function cancelEngineTask(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  body: Record<string, string>,
): Promise<CancelResult> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Cancel failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: CancelResult } | null;
  if (!parsed?.data) {
    throw new Error(`Cancel succeeded (${res.status}) but the response had no task data`);
  }
  return parsed.data;
}

/** Success message: the cancelled `#N`/title and its new runtime state. */
export function renderCancelled(task: CancelResult): string {
  const n = task.displayNumber != null ? `#${task.displayNumber} ` : "";
  return `[engine-cancel] Cancelled ${n}${task.title} — ${task.id} (now ${task.runtimeState}).\n`;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const reason = parseReasonArg(argv);
  // The identifier is the first positional arg — skipping any `--flag` AND the value
  // that follows a bare `--reason` (so `42 --reason superseded` resolves to `42`).
  let identifier: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reason") {
      i++; // skip its value
      continue;
    }
    if (argv[i].startsWith("--")) continue;
    identifier = argv[i];
    break;
  }

  if (!identifier) {
    process.stderr.write(
      "[engine-cancel] Usage: npm run engine:cancel -- <#N | slug | uuid | title-fragment>\n",
    );
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-cancel] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-cancel] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let task: CancelResult;
  try {
    task = await cancelEngineTask(fetch, cfg, token, buildCancelBody(identifier, cfg.projectId, reason));
  } catch (err) {
    process.stderr.write(`[engine-cancel] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(renderCancelled(task));
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-cancel.ts"))) {
  void run();
}
