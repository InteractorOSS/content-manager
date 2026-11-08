#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Set an engine task's or goal's `priority` from the terminal (engine:priority).
 *
 * Priority (low|medium|high|urgent) drives Goals-surface ordering and is the
 * operator's hand-set rank. Until now it was only writable via the browser-session
 * v2 PATCH routes (authorizeProject = NextAuth), so headless/CLI reprioritization
 * was impossible. This drives the daemon-token PATCH endpoints added in #459:
 *   PATCH /api/v1/me/engine/tasks/:id   { priority }
 *   PATCH /api/v1/me/engine/goals/:id   { priority }
 *
 * Which lever moves the fleet queue: the fleet now claims at the GOAL grain — the
 * cross-goal claim order follows GOAL priority -> goal age -> goal id (see
 * `compareGoalClaimKeys` / fleet-queue.ts). So `engine:priority goal <id>` is the
 * lever that jumps the cross-goal fleet queue. `engine:priority task` only reorders
 * a task WITHIN its own goal (`compareClaimKeys`: task priority -> age -> id); it no
 * longer affects which GOAL the fleet picks up next.
 *
 * A task is addressed like engine:work/engine:cancel — `#N` / slug / title
 * fragment / raw UUID (resolved first via /me/engine/resolve). A goal is
 * addressed by raw UUID only (goals have no #N/slug resolver yet — same
 * limitation as engine:goal). Credential + config are shared with
 * engine-claim/engine-work: `.build/.sync` (or legacy `.tasks/.sync`) + PM_DAEMON_TOKEN.
 *
 * Usage:
 *   npm run engine:priority -- task <#N | slug | uuid | title-fragment> <low|medium|high|urgent>
 *   npm run engine:priority -- goal <goalId> <low|medium|high|urgent>
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { resolveTask, summaryLine } from "./engine-work";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a bare UUID (a goal id, or a task id passed directly). */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export const USAGE =
  "Usage:\n" +
  "  npm run engine:priority -- task <#N | slug | uuid | title-fragment> <low|medium|high|urgent>\n" +
  "  npm run engine:priority -- goal <goalId> <low|medium|high|urgent>";

export type ParsedArgs =
  | { ok: true; target: "task" | "goal"; identifier: string; priority: Priority }
  | { ok: false; error: string };

/**
 * Parse `<task|goal> <identifier> <priority>` from the positional args (flags
 * ignored). Validates the subcommand and the priority against the enum; the
 * identifier is whatever non-flag token sits between them.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const pos = argv.filter((a) => !a.startsWith("--"));
  const [target, identifier, priority] = pos;
  if (target !== "task" && target !== "goal") {
    return { ok: false, error: `Unknown or missing target "${target ?? ""}" (expected task|goal).\n${USAGE}` };
  }
  if (!identifier) {
    return { ok: false, error: `Missing ${target} identifier.\n${USAGE}` };
  }
  if (!priority || !(PRIORITIES as readonly string[]).includes(priority)) {
    return { ok: false, error: `Missing or invalid priority "${priority ?? ""}" (expected ${PRIORITIES.join("|")}).\n${USAGE}` };
  }
  return { ok: true, target, identifier, priority: priority as Priority };
}

/** The minimal row both PATCH endpoints echo back in `{ data }`. */
export interface PriorityResult {
  id: string;
  displayNumber: number | null;
  title: string;
  priority: string;
}

/** Shared PATCH against a /me/engine/{tasks,goals}/:id endpoint. Throws the server's `message` on non-OK. */
async function patchPriority(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  kind: "tasks" | "goals",
  id: string,
  priority: Priority,
): Promise<PriorityResult> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/${kind}/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ priority }),
  });
  if (!res.ok) {
    let msg = `Priority update failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: PriorityResult } | null;
  if (!parsed?.data) {
    throw new Error(`Priority update succeeded (${res.status}) but the response had no data`);
  }
  return parsed.data;
}

/** Set a task's priority. Resolves the identifier first (so `#N`/slug/title all work). */
export async function setTaskPriority(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  identifier: string,
  priority: Priority,
): Promise<PriorityResult> {
  let taskId = identifier;
  if (!isUuid(identifier)) {
    const resolution = await resolveTask(fetchFn, cfg, token, identifier);
    if (resolution.kind === "ambiguous") {
      throw new Error(
        `"${identifier}" matches multiple tasks — be more specific (use #N or the id):\n` +
          resolution.matches.map(summaryLine).join("\n"),
      );
    }
    if (resolution.kind === "not_found") {
      const hint =
        resolution.suggestions.length > 0
          ? `\nDid you mean:\n${resolution.suggestions.map(summaryLine).join("\n")}`
          : "";
      throw new Error(`No engine task matches "${identifier}".${hint}`);
    }
    taskId = resolution.task.id;
  }
  return patchPriority(fetchFn, cfg, token, "tasks", taskId, priority);
}

/** Set a goal's priority. Goals are addressed by raw UUID only (no resolver yet). */
export async function setGoalPriority(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
  priority: Priority,
): Promise<PriorityResult> {
  if (!isUuid(goalId)) {
    throw new Error(`A goal must be addressed by its UUID (got "${goalId}").`);
  }
  return patchPriority(fetchFn, cfg, token, "goals", goalId, priority);
}

/** Success message: the updated `#N`/title and its new priority. */
export function renderUpdated(target: "task" | "goal", row: PriorityResult): string {
  const n = row.displayNumber != null ? `#${row.displayNumber} ` : "";
  return `[engine-priority] Set ${target} ${n}${row.title} — priority: ${row.priority}.\n`;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`[engine-priority] ${parsed.error}\n`);
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-priority] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-priority] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let row: PriorityResult;
  try {
    row =
      parsed.target === "task"
        ? await setTaskPriority(fetch, cfg, token, parsed.identifier, parsed.priority)
        : await setGoalPriority(fetch, cfg, token, parsed.identifier, parsed.priority);
  } catch (err) {
    process.stderr.write(`[engine-priority] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(renderUpdated(parsed.target, row));
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-priority.ts"))) {
  void run();
}
