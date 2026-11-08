#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local engine-task status vehicle (cutover C2c).
 *
 * The engine analog of the legacy `/i/task-status`: resolves a task identifier
 * (#N / slug / title-fragment) and prints its lifecycle state — phase,
 * runtime_state, goal (+ the goal it belongs to), open pauses on the task, and
 * the unresolved must-fix review-finding count — so a developer running the
 * local engine loop can see where a task stands without the web UI.
 *
 * Read-only. Composes three account-level daemon-token reads:
 *   GET /me/engine/resolve   (identifier → task)
 *   GET /me/engine/tasks/:id (task + goal + findings summary)
 *   GET /me/engine/pauses    (open pauses on the task)
 *
 * Credential + config are shared with engine-claim/work/report: `.build/.sync` (or legacy `.tasks/.sync`)
 * for the base URL + project id, PM_DAEMON_TOKEN from the environment.
 *
 * The task's open pauses are owner-scoped to "mine" by default (my + unowned), matching
 * engine:attention / the web feed; `--all` shows pauses regardless of owner.
 *
 * Usage:
 *   npm run engine:status -- <#N | slug | title-fragment>          # my + unowned pauses on the task
 *   npm run engine:status -- <#N | slug | title-fragment> --all    # pauses regardless of owner
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { resolveTask, summaryLine } from "./engine-work";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface StatusGoal {
  id?: string;
  displayNumber: number | null;
  title: string;
  // PR auto-open diagnostic fields (threaded from the task GET route's goal DTO). Optional
  // so older payloads / tests without them still render the goal line. `tasksComplete` gates
  // whether the "no PR yet" reason is worth showing (before completion, no PR is expected).
  prBoundary?: boolean;
  prState?: string;
  prAutoOpenReason?: string | null;
  tasksComplete?: boolean;
}

/**
 * Why a task-complete goal has NO open PR yet — the terminal twin of the goal-detail
 * banner (`derivePrAutoOpenDiagnostic`). Reads the persisted auto-open decline reason so a
 * terminal operator sees the cause without opening the web UI. Returns null when there is
 * nothing to explain (goal not task-complete, a live/shipped PR already exists, or a
 * boundary goal whose recovery sweep hasn't recorded a decline yet). Pure — unit-testable.
 */
export function formatGoalPrAutoOpenLine(goal: StatusGoal): string | null {
  if (!goal.tasksComplete) return null;
  // Only `none`/`closed` (or unknown) are "no open PR" — a draft/ready/merged PR means
  // auto-open already succeeded, so there's nothing to diagnose.
  if (goal.prState === "draft" || goal.prState === "ready" || goal.prState === "merged") return null;

  if (goal.prBoundary === false) {
    return "pr:        no PR — PR boundary is off; this goal will not auto-open a PR";
  }
  switch (goal.prAutoOpenReason) {
    case "branch_missing":
      return "pr:        no PR — branch not pushed yet; the engine retries ~every 5 min (no action needed)";
    case "create_failed":
      return "pr:        no PR — GitHub PR create failed; see logs, then open the PR manually or retry";
    case "no_github":
      return "pr:        no PR — GitHub not connected; connect it and the engine will open the PR on its next run";
    default:
      // A persisted reason the CLI doesn't recognize (e.g. a newer code) must NOT silently
      // vanish — that reproduces the exact no-signal dead-end this diagnostic exists to
      // remove. Render the raw reason string so a terminal operator still sees WHY.
      if (goal.prAutoOpenReason) {
        return `pr:        no PR — auto-open declined: ${goal.prAutoOpenReason}; see logs`;
      }
      // Boundary on, task-complete, no live PR, but no decline recorded — the sweep hasn't
      // run yet. Don't fabricate a cause.
      return null;
  }
}

export interface StatusTask {
  id: string;
  displayNumber: number | null;
  title: string;
  type: string;
  phase: string;
  runtimeState: string;
  priority?: string | null;
  goal?: StatusGoal | null;
}

export interface FindingItem {
  key: string;
  summary: string;
  severity?: string | null;
  mustFix: boolean;
  status?: string | null;
}

export interface FindingsSummary {
  unresolved: number;
  unresolvedMustFix: number;
  items?: FindingItem[];
}

export interface StatusPause {
  id: string;
  kind: string;
  reason: string | null;
}

/** Render the full status view. Pure — no I/O — so it's unit-testable. */
export function formatStatus(
  task: StatusTask,
  findings: FindingsSummary,
  pauses: StatusPause[],
): string {
  const n = task.displayNumber != null ? `#${task.displayNumber} ` : "";
  const lines: string[] = [];
  lines.push(`[engine-status] ${n}${task.title}`);
  lines.push(`  id:        ${task.id}`);
  lines.push(`  type:      ${task.type}`);
  lines.push(`  phase:     ${task.phase}`);
  lines.push(`  state:     ${task.runtimeState}`);
  if (task.priority) lines.push(`  priority:  ${task.priority}`);
  if (task.goal) {
    const gn = task.goal.displayNumber != null ? `G#${task.goal.displayNumber} ` : "";
    lines.push(`  goal:      ${gn}${task.goal.title}`);
    // Surface WHY a task-complete goal has no open PR yet (persisted auto-open decline
    // reason) — the terminal counterpart to the goal-detail banner. Null → nothing to say.
    const prLine = formatGoalPrAutoOpenLine(task.goal);
    if (prLine) lines.push(`  ${prLine}`);
  } else {
    lines.push(`  goal:      (none)`);
  }
  lines.push(
    `  findings:  ${findings.unresolved} unresolved` +
      (findings.unresolvedMustFix > 0 ? ` (${findings.unresolvedMustFix} must-fix)` : ""),
  );
  // Render the unresolved finding bodies so the executor can read what needs
  // fixing without opening the web UI. must-fix items are tagged distinctly from
  // warnings so the priority is obvious at a glance.
  if (findings.items && findings.items.length > 0) {
    for (const f of findings.items) {
      const tag = f.mustFix ? "[must-fix]" : "[  warn  ]";
      lines.push(`    ${tag} ${f.key}: ${f.summary}`);
    }
  }
  if (pauses.length === 0) {
    lines.push(`  pauses:    none open`);
  } else {
    lines.push(`  pauses:    ${pauses.length} open`);
    for (const p of pauses) {
      lines.push(`    - ${p.kind}${p.reason ? `: ${p.reason}` : ""} (${p.id})`);
    }
  }
  return lines.join("\n") + "\n";
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** GET /me/engine/tasks/:id — task (+ goal) + findings summary. Throws on non-OK. */
export async function fetchTask(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  taskId: string,
): Promise<{ task: StatusTask; findings: FindingsSummary }> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Task fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: StatusTask; findings: FindingsSummary };
  return { task: body.data, findings: body.findings };
}

/** GET /me/engine/pauses?projectId=&taskId= — open pauses on a task. Throws on non-OK.
 *  Owner-scoped `mine` by default (server default), matching engine:attention / the web feed:
 *  a pause on a task owned by someone else drops off unless `--all` (owner=all) is passed. */
export async function fetchTaskPauses(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  taskId: string,
  opts: { all?: boolean } = {},
): Promise<StatusPause[]> {
  // Omit the owner param on the default so the server's `mine` default owns the scope; `--all`
  // opts into the full set. Same convention as engine:attention's listPauses (no client drift).
  const ownerParam = opts.all ? "&owner=all" : "";
  const url =
    `${cfg.baseUrl}/api/v1/me/engine/pauses` +
    `?projectId=${encodeURIComponent(cfg.projectId)}&taskId=${encodeURIComponent(taskId)}${ownerParam}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Pauses fetch failed: ${res.status}`);
  // The endpoint returns a UNIFIED attention list (task #405): pauses + approvals + link-only
  // items (risk, and — in task-narrowed mode — `stalled`). This status view renders only
  // pauses, so keep ONLY pause items rather than "everything that isn't an approval" — the old
  // negative filter let a `stalled`/`risk` item through to be mis-rendered as a pause (it has no
  // kind/reason). Pauses carry `type: "pause"` (older rows may be untagged → undefined).
  const body = (await res.json()) as { data: (StatusPause & { type?: string })[] };
  return (body.data ?? []).filter((it) => it.type === "pause" || it.type === undefined);
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  const identifier = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
  // `--all` lifts the owner scope on the task's pauses to every owner (default = mine + unowned).
  const all = process.argv.slice(2).includes("--all");
  if (!identifier) {
    process.stderr.write("[engine-status] Usage: npm run engine:status -- <#N | slug | title-fragment>\n");
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-status] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-status] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    const resolution = await resolveTask(fetch, cfg, token, identifier);
    if (resolution.kind === "ambiguous") {
      process.stderr.write(`[engine-status] "${identifier}" matches multiple tasks — be more specific:\n`);
      resolution.matches.forEach((m) => process.stderr.write(summaryLine(m) + "\n"));
      process.exit(1);
    }
    if (resolution.kind === "not_found") {
      process.stderr.write(`[engine-status] No engine task matches "${identifier}".\n`);
      if (resolution.suggestions.length > 0) {
        process.stderr.write("Did you mean:\n");
        resolution.suggestions.forEach((s) => process.stderr.write(summaryLine(s) + "\n"));
      }
      process.exit(1);
    }

    const taskId = resolution.task.id;
    const [{ task, findings }, pauses] = await Promise.all([
      fetchTask(fetch, cfg, token, taskId),
      fetchTaskPauses(fetch, cfg, token, taskId, { all }),
    ]);
    process.stdout.write(formatStatus(task, findings, pauses));
  } catch (err) {
    process.stderr.write(`[engine-status] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-status.ts"))) {
  void run();
}
