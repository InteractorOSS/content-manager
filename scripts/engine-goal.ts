#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local goal review gate vehicle (cutover C2c).
 *
 * The engine analog of the legacy land/reopen decision, on the GOAL (the
 * integration unit). `accept` delivers the goal (A5b — for a `prBoundary` goal
 * this merges its PR, gated on ready + mergeable; for a non-boundary goal it
 * just marks it accepted). `request-changes` spawns a rework task under the goal
 * and moves it back to in_progress.
 *
 * The CLI takes a SINGLE `--title`/`--desc` and wraps it into the route's
 * one-element `changes: [{ title, description }]` array — the route body is the
 * v2 `request_changes` discriminated union verbatim (a `changes` array, min 1),
 * NOT a flattened body.
 *
 * Out-of-scope note: with the daemon goal-PR git machinery not yet built, a
 * `prBoundary` goal has no real PR, so `accept` will surface the server's 409
 * ("PR must be ready" / "not mergeable") — expected. A non-boundary goal
 * accepts cleanly.
 *
 * `close` (#431) marks a goal terminal (`cancelled`) WITHOUT delivering it — no merge,
 * no gate. The escape hatch for a goal `accept` can't close: chiefly a `prBoundary`
 * goal whose PR was merged out of band (so `prState` never reached `ready` and `accept`
 * 409s forever), or a simply-abandoned goal.
 *
 * Goal identifier (G#491): `<goalId>` accepts a raw UUID OR a `G#<n>`/`#<n>`/bare-`<n>`/
 * slug/title-fragment shorthand, resolved via `resolveGoalRef` against the same
 * `/me/engine/goals/resolve` endpoint the web UI and other engine-*.ts scripts use — the
 * goal analog of `resolveTask` (engine-work.ts). Every printed result line shows `G#<n>`
 * (falling back to the UUID when the goal has no display number yet).
 *
 * `queue` admits (queues) a goal for autopilot — the terminal counterpart to the
 * web "Queue goal" button. Since #1387 (goals born task-less + dormant; planning
 * spawns at admission), a goal created from the CLI has no task to `engine:queue`
 * and the only admit path was the session-only v2 resume route — so a headless
 * goal could never be started without the browser. `queue` calls the daemon
 * `POST /me/engine/goals/:id/resume` (same `resumeGoalBacklog` service), which
 * stamps `admittedAt`, promotes any backlog tasks, and spawns the planning task.
 * Because that hands the goal to the fleet, `queue` now prints a blast-radius
 * notice pointing at the `pause` brake below.
 *
 * `pause` / `resume` are the reversible hold/release pair for an ALREADY-admitted
 * goal — the headless brake that was missing when an over-`queue`d goal couldn't be
 * held, only `close`d (terminal). `pause` calls the daemon `POST /me/engine/goals/
 * :id/pause` (the `pauseGoal` service — sets a manual goal-level pause the claim gate
 * skips, and clears admission), so the fleet takes NO new work on it until `resume`.
 * `resume` hits the SAME `/resume` endpoint as `queue` (the `resumeGoal` service is a
 * superset that lifts the pause + re-admits), just with resume-flavoured output.
 *
 * Usage:
 *   npm run engine:goal -- accept <goalId>
 *   npm run engine:goal -- request-changes <goalId> --title "..." [--desc "..."]
 *   npm run engine:goal -- close <goalId> [--reason "..."]
 *   npm run engine:goal -- queue <goalId>
 *   npm run engine:goal -- pause <goalId> [--reason "..."]
 *   npm run engine:goal -- resume <goalId>
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export type GoalAction = "accept" | "request_changes" | "close" | "link_pr" | "queue" | "pause" | "resume";

export interface GoalArgs {
  action: GoalAction;
  goalId: string;
  title?: string;
  description?: string;
  /** #431: optional close reason for `close`. */
  reason?: string;
  /** S4 (link-pr): explicit PR number to link; omit to resolve it from GitHub by branch. */
  prNumber?: number;
  /** S4 (link-pr): optional PR url to record alongside the number. */
  prUrl?: string;
  /** link-pr: explicit opt-in to clear a stale prNumber and re-attach (recover a goal whose
   *  PR was closed/reassigned). Never automatic. */
  relink?: boolean;
  /** Multi-repo goals (S4): the repo-target connectionId to link the PR onto (default: the
   *  goal's primary repo). */
  connectionId?: string;
  /** pause: also stop in-flight runs under the goal (abort + re-queue at current phase). */
  stopRunning?: boolean;
}

export type GoalParse = { ok: true; args: GoalArgs } | { ok: false; error: string };

const USAGE =
  "Usage:\n" +
  "  npm run engine:goal -- accept <goalId>\n" +
  '  npm run engine:goal -- request-changes <goalId> --title "..." [--desc "..."]\n' +
  '  npm run engine:goal -- close <goalId> [--reason "..."]\n' +
  "  npm run engine:goal -- link-pr <goalId> [--number N] [--url U] [--relink] [--connection <connectionId>]\n" +
  "  npm run engine:goal -- queue <goalId>\n" +
  '  npm run engine:goal -- pause <goalId> [--reason "..."] [--stop-running]\n' +
  "  npm run engine:goal -- resume <goalId>";

/**
 * Parse the subcommand (`accept` / `request-changes`), the goalId (first non-flag
 * after it), and `--title` / `--desc` for request-changes. Validation of the goal
 * id + change shape is enforced server-side (404 / 422); this enforces CLI shape.
 */
export function parseGoalArgs(argv: string[]): GoalParse {
  const sub = argv[0];
  if (
    sub !== "accept" &&
    sub !== "request-changes" &&
    sub !== "close" &&
    sub !== "link-pr" &&
    sub !== "queue" &&
    sub !== "pause" &&
    sub !== "resume"
  ) {
    return { ok: false, error: `Unknown or missing subcommand "${sub ?? ""}".\n${USAGE}` };
  }
  const action: GoalAction =
    sub === "accept"
      ? "accept"
      : sub === "close"
        ? "close"
        : sub === "link-pr"
          ? "link_pr"
          : sub === "queue"
            ? "queue"
            : sub === "pause"
              ? "pause"
              : sub === "resume"
                ? "resume"
                : "request_changes";

  let goalId: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  let reason: string | undefined;
  let prNumber: number | undefined;
  let prUrl: string | undefined;
  let relink: boolean | undefined;
  // Left undefined (not false) when the flag is absent so parse results still `toEqual`
  // the minimal `{ action, goalId }` shape (toEqual ignores undefined, not false).
  let stopRunning: boolean | undefined;
  let connectionId: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--title") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for --title\n${USAGE}` };
      title = val;
      continue;
    }
    if (tok === "--desc") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for --desc\n${USAGE}` };
      description = val;
      continue;
    }
    if (tok === "--reason") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for --reason\n${USAGE}` };
      reason = val;
      continue;
    }
    if (tok === "--stop-running") {
      stopRunning = true;
      continue;
    }
    if (tok === "--relink") {
      relink = true;
      continue;
    }
    if (tok === "--number") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for --number\n${USAGE}` };
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `--number must be a positive integer\n${USAGE}` };
      prNumber = n;
      continue;
    }
    if (tok === "--url") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for --url\n${USAGE}` };
      prUrl = val;
      continue;
    }
    if (tok === "--connection") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for --connection\n${USAGE}` };
      connectionId = val;
      continue;
    }
    if (tok.startsWith("--")) return { ok: false, error: `Unknown flag ${tok}\n${USAGE}` };
    if (goalId === undefined && tok !== "") {
      goalId = tok;
      continue;
    }
    return { ok: false, error: `Unexpected argument "${tok}"\n${USAGE}` };
  }

  if (!goalId) return { ok: false, error: `A goalId is required.\n${USAGE}` };
  if (action === "request_changes" && !title) {
    return { ok: false, error: `request-changes requires --title.\n${USAGE}` };
  }
  return { ok: true, args: { action, goalId, title, description, reason, prNumber, prUrl, relink, connectionId, stopRunning } };
}

/**
 * Shape the review POST body. For request_changes, wrap the single title/desc
 * into the one-element `changes` array the route's v2 schema expects.
 */
export function buildReviewBody(args: GoalArgs): Record<string, unknown> {
  if (args.action === "accept") return { action: "accept" };
  if (args.action === "close") {
    return { action: "close", ...(args.reason ? { reason: args.reason } : {}) };
  }
  return {
    action: "request_changes",
    changes: [
      { title: args.title!, ...(args.description ? { description: args.description } : {}) },
    ],
  };
}

export interface ReviewResultData {
  goal?: { id?: string; status?: string; prState?: string | null };
  prTransitioned?: boolean;
  tasks?: Array<{ id?: string; displayNumber?: number | null; title?: string }>;
}

/** Human-readable result line for a goal review outcome. `label` is the pre-resolved
 *  `G#<n>` (or UUID fallback) from the caller's identifier resolution — preferred over
 *  `data.goal?.id` so every result line prints the display number, not the raw UUID. */
export function formatGoalResult(action: GoalAction, data: ReviewResultData, label?: string): string {
  const goalId = label ?? data.goal?.id ?? "?";
  const status = data.goal?.status ?? "?";
  if (action === "accept") {
    const merged = data.prTransitioned ? " (PR merged)" : "";
    return `[engine-goal] Accepted goal ${goalId} — status: ${status}${merged}.\n`;
  }
  if (action === "close") {
    return `[engine-goal] Closed goal ${goalId} — status: ${status}.\n`;
  }
  const tasks = data.tasks ?? [];
  const lines = [`[engine-goal] Requested changes on goal ${goalId} — status: ${status}; spawned ${tasks.length} rework task(s):`];
  for (const t of tasks) {
    const n = t.displayNumber != null ? `#${t.displayNumber} ` : "";
    lines.push(`  - ${n}${t.title ?? ""} (${t.id ?? "?"})`);
  }
  return lines.join("\n") + "\n";
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ─── Goal identifier resolution (G#491) ────────────────────────────────────────
// The goal analog of resolveTask (engine-work.ts) / resolveTaskRef (engine-create.ts):
// resolve a G#<n>/#<n>/bare-<n>/slug/title-fragment ref to a real goal id + display
// number, via GET /me/engine/goals/resolve. A raw UUID is used directly (the resolver
// matches displayNumber/slug/title, not raw ids).

const GOAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isGoalUuid(s: string): boolean {
  return GOAL_UUID_RE.test(s);
}

export interface ResolvedGoalRef {
  id: string;
  displayNumber: number | null;
}

/** `G#<n>` when a display number is known, else the raw id — the one label every
 *  engine-goal.ts result line prints instead of a bare UUID. */
export function goalLabel(ref: ResolvedGoalRef): string {
  return ref.displayNumber != null ? `G#${ref.displayNumber}` : ref.id;
}

/**
 * Resolve a `<goalId>` CLI arg (G#<n> / #<n> / bare-<n> / slug / title-fragment / uuid) to
 * `{ id, displayNumber }`. A raw UUID short-circuits (used directly; the server still
 * validates it exists). Otherwise hits the shared resolve endpoint; throws a legible error
 * on ambiguity/not-found, mirroring resolveTaskRef's contract.
 */
export async function resolveGoalRef(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  ref: string,
): Promise<ResolvedGoalRef> {
  if (isGoalUuid(ref)) return { id: ref, displayNumber: null };
  const url = `${cfg.baseUrl}/api/v1/me/engine/goals/resolve?projectId=${encodeURIComponent(cfg.projectId)}&identifier=${encodeURIComponent(ref)}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`could not resolve "${ref}": ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    data?: { kind: string; goal?: { id: string; displayNumber: number | null } };
  } | null;
  const r = body?.data;
  if (r?.kind === "found" && r.goal) return { id: r.goal.id, displayNumber: r.goal.displayNumber };
  if (r?.kind === "ambiguous") throw new Error(`"${ref}" matches multiple goals — be more specific`);
  throw new Error(`"${ref}" matched no goal in this project`);
}

/** POST /me/engine/goals/:id/review. Returns the `{ data }` payload. Throws the server message on non-OK. */
export async function reviewGoal(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
  body: Record<string, unknown>,
): Promise<ReviewResultData> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals/${goalId}/review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Goal review failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: ReviewResultData } | null;
  if (!parsed?.data) {
    throw new Error(`Goal review succeeded (${res.status}) but the response had no data`);
  }
  return parsed.data;
}

export interface LinkPrResultData {
  prNumber?: number;
  branch?: string;
  alreadyLinked?: boolean;
}

/**
 * S4: POST /me/engine/goals/:id/pr — link the goal to its integration PR (the first-class
 * hand-drive seam). With no `number` the server resolves the PR from GitHub by the goal's
 * canonical branch. Returns the `{ data }` payload; throws the server message on non-OK.
 */
export async function linkGoalPr(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
  body: { number?: number; url?: string; relink?: boolean; connectionId?: string },
): Promise<LinkPrResultData> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals/${goalId}/pr`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Goal PR link failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: LinkPrResultData } | null;
  if (!parsed?.data) {
    throw new Error(`Goal PR link succeeded (${res.status}) but the response had no data`);
  }
  return parsed.data;
}

/** Human-readable result line for a link-pr outcome. */
export function formatLinkPrResult(goalId: string, data: LinkPrResultData, relink?: boolean): string {
  const where = data.branch ? ` on ${data.branch}` : "";
  if (data.alreadyLinked) {
    return `[engine-goal] Goal ${goalId} already linked to PR #${data.prNumber ?? "?"}${where}.\n`;
  }
  // A `--relink` that actually re-attached (server cleared a stale prNumber) reads as "Relinked".
  const verb = relink ? "Relinked" : "Linked";
  return `[engine-goal] ${verb} goal ${goalId} to PR #${data.prNumber ?? "?"}${where}.\n`;
}

export interface QueueResultData {
  promoted?: number;
  admitted?: boolean;
  /** Pipeline admission: goal admitted but still blocked by a non-terminal predecessor. */
  gated?: boolean;
  /** resume only: number of failure pauses (run_failure / deliverable_incomplete) retried. */
  retried?: number;
}

/**
 * Shared transport for `POST /me/engine/goals/:id/resume` — used by BOTH `queue`
 * (admit a dormant goal) and `resume` (lift a manual pause + re-admit). They hit
 * the same route because the `resumeGoal` service is a superset of admission; only
 * the caller-facing wording differs (`verb` colours the error prefix). Returns the
 * `{ data }` payload; throws the server message on non-OK (e.g. a 409 when a paused
 * predecessor still blocks, or a human-input pause is still open).
 */
async function postGoalResume(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
  verb: "queue" | "resume",
): Promise<QueueResultData> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals/${goalId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    let msg = `Goal ${verb} failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: QueueResultData } | null;
  if (!parsed?.data) {
    throw new Error(`Goal ${verb} succeeded (${res.status}) but the response had no data`);
  }
  return parsed.data;
}

/**
 * `queue`: admit (queue) the goal for autopilot, the daemon counterpart to the web
 * "Queue goal" button. Reuses the `resumeGoal` service (stamps `admittedAt`, promotes
 * backlog tasks, spawns the planning task).
 */
export async function queueGoal(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
): Promise<QueueResultData> {
  return postGoalResume(fetchFn, cfg, token, goalId, "queue");
}

/** `resume`: lift a manual goal pause and re-admit — the inverse of `pause`. Same
 *  endpoint/service as `queue` (a superset that also clears the pause). */
export async function resumeGoal(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
): Promise<QueueResultData> {
  return postGoalResume(fetchFn, cfg, token, goalId, "resume");
}

/** Human-readable result line for a queue outcome — words it off BOTH signals (tasks
 *  promoted and/or the goal newly admitted), mirroring the web Resume toast. A queue
 *  admits the goal to the fleet, so append a blast-radius notice pointing at `pause`. */
export function formatQueueResult(goalId: string, data: QueueResultData): string {
  const promoted = data.promoted ?? 0;
  const admitted = data.admitted ?? false;
  const notice =
    `[engine-goal] ⚠ This goal is now admitted to the fleet — it will be scoped and run ` +
    `AUTONOMOUSLY. To hold it: npm run engine:goal -- pause ${goalId}\n`;
  if (promoted > 0) {
    return `[engine-goal] Queued goal ${goalId} — promoted ${promoted} task(s).\n` + notice;
  }
  if (admitted) {
    return `[engine-goal] Queued goal ${goalId} — admitted; new work runs automatically.\n` + notice;
  }
  return `[engine-goal] Goal ${goalId} already queued.\n`;
}

/** Human-readable result line for a resume outcome — the inverse framing of pause. */
export function formatResumeResult(goalId: string, data: QueueResultData): string {
  const promoted = data.promoted ?? 0;
  const admitted = data.admitted ?? false;
  const gated = data.gated ?? false;
  if (gated) {
    return `[engine-goal] Resumed goal ${goalId} — lifted pause, but still dependency-gated; it starts when its predecessors clear.\n`;
  }
  if (promoted > 0) {
    return `[engine-goal] Resumed goal ${goalId} — lifted pause; promoted ${promoted} task(s), new work runs automatically.\n`;
  }
  if (admitted) {
    return `[engine-goal] Resumed goal ${goalId} — lifted pause; new work runs automatically.\n`;
  }
  return `[engine-goal] Resumed goal ${goalId} — no manual pause was set.\n`;
}

export interface PauseResultData {
  paused?: boolean;
  /** With --stop-running: how many in-flight runs were aborted + re-queued. */
  preempted?: number;
}

/**
 * `pause`: POST /me/engine/goals/:id/pause — set a manual goal-level pause (the claim
 * gate skips a paused goal) and clear admission, so the fleet takes NO new work on it
 * until `resume`. The daemon counterpart to the web "Pause" button; the reversible
 * alternative to `close`. Returns the `{ data }` payload; throws the server message on
 * non-OK.
 */
export async function pauseGoal(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
  reason?: string,
  stopRunning?: boolean,
): Promise<PauseResultData> {
  const body: Record<string, unknown> = {};
  if (reason) body.reason = reason;
  if (stopRunning) body.stopRunning = true;
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals/${goalId}/pause`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Goal pause failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: PauseResultData } | null;
  if (!parsed?.data) {
    throw new Error(`Goal pause succeeded (${res.status}) but the response had no data`);
  }
  return parsed.data;
}

/** Human-readable result line for a pause outcome. `pauseGoal` sets `pausedAt`
 *  UNCONDITIONALLY (updateMany, no pause-state predicate), so `paused:false` does NOT
 *  mean "already paused" — it means no row updated, i.e. the goal was deleted between the
 *  route's tenancy read and the write (a rare race). Report that honestly, not a stale
 *  "already paused". (Re-pausing an already-paused goal still returns `paused:true`.) */
export function formatPauseResult(goalId: string, data: PauseResultData): string {
  const paused = data.paused ?? false;
  if (!paused) {
    return `[engine-goal] Goal ${goalId} could not be paused — it may no longer exist.\n`;
  }
  const stopped =
    (data.preempted ?? 0) > 0
      ? ` Stopped ${data.preempted} running task(s) — they re-run when you resume.`
      : "";
  return `[engine-goal] Paused goal ${goalId} — the fleet will take no new work on it.${stopped} Release with: npm run engine:goal -- resume ${goalId}\n`;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  const parsedArgs = parseGoalArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    process.stderr.write(`[engine-goal] ${parsedArgs.error}\n`);
    process.exit(1);
  }
  const args = parsedArgs.args;

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-goal] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-goal] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Resolve the typed identifier (G#<n>/#<n>/bare-<n>/slug/title-fragment/uuid) to a real
  // id + display number BEFORE dispatching, so every result line below prints G#<n>
  // instead of the raw UUID.
  let ref: ResolvedGoalRef;
  try {
    ref = await resolveGoalRef(fetch, cfg, token, args.goalId);
  } catch (err) {
    process.stderr.write(`[engine-goal] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const label = goalLabel(ref);
  args.goalId = ref.id;

  try {
    if (args.action === "link_pr") {
      const data = await linkGoalPr(fetch, cfg, token, args.goalId, { number: args.prNumber, url: args.prUrl, relink: args.relink, connectionId: args.connectionId });
      process.stdout.write(formatLinkPrResult(label, data, args.relink));
    } else if (args.action === "queue") {
      const data = await queueGoal(fetch, cfg, token, args.goalId);
      process.stdout.write(formatQueueResult(label, data));
    } else if (args.action === "pause") {
      const data = await pauseGoal(fetch, cfg, token, args.goalId, args.reason, args.stopRunning);
      process.stdout.write(formatPauseResult(label, data));
    } else if (args.action === "resume") {
      const data = await resumeGoal(fetch, cfg, token, args.goalId);
      process.stdout.write(formatResumeResult(label, data));
    } else {
      const data = await reviewGoal(fetch, cfg, token, args.goalId, buildReviewBody(args));
      process.stdout.write(formatGoalResult(args.action, data, label));
    }
  } catch (err) {
    process.stderr.write(`[engine-goal] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-goal.ts"))) {
  void run();
}
