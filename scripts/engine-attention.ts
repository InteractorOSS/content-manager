#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local "attention" vehicle — list + answer the open ATTENTION ITEMS for the
 * current project from the CLI, the headless counterpart of the web /attention
 * page. Attention items are engine PAUSES (a run stopped on a clarification,
 * risk gate, run failure, …) AND pending APPROVALS (a sign-off requested on a
 * release / task / deliverable / phase / decision / checkpoint / change
 * request), surfaced via the daemon-token routes:
 *   GET  /api/v1/me/engine/pauses?projectId=…           (unified pause|approval list)
 *   POST /api/v1/me/engine/pauses/:id/resolve   { resolution, answer?, action? }   (pause)
 *   POST /api/v1/me/engine/approvals/:id/decide { action, comment? }               (approval)
 * This wraps them so a remote operator can unblock a run — or clear an
 * approval — without the web UI.
 *
 * Config + credential are shared with the rest of the engine loop: `.build/.sync` (or legacy `.tasks/.sync`)
 * for the base URL + project id, PM_DAEMON_TOKEN from the environment.
 *
 * By default the list is owner-scoped to "mine" — items owned by me OR unowned — matching the
 * web /attention feed's Mine default, so a remote operator asking "what needs MY attention?"
 * isn't buried under the whole project's open items. `--all` lifts the scope to every open item.
 *
 * Usage:
 *   npm run engine:attention                                   # list MY open pauses + approvals (+ unowned)
 *   npm run engine:attention -- --all                          # list EVERY open item in the project
 *   npm run engine:attention -- answer <pauseId> "<answer>"    # resume a clarification with an answer
 *   npm run engine:attention -- answer <pauseId> --cancel      # cancel the paused task
 *   npm run engine:attention -- answer <pauseId> --waive       # waive (proceed without addressing)
 *   npm run engine:attention -- answer <pauseId> --mark-done-oob      # out_of_band_commit: the human already delivered the work
 *   npm run engine:attention -- answer <pauseId> --continue-lifecycle # out_of_band_commit: re-queue onto the human's commits
 *   npm run engine:attention -- answer <pauseId> --dismiss-oob        # out_of_band_commit: suppress until the next new push
 *   npm run engine:attention -- answer <approvalId> --approve  # grant a pending approval
 *   npm run engine:attention -- answer <approvalId> --reject "<reason>"  # reject (reason required)
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface PauseRow {
  type?: "pause";
  id: string;
  kind: string;
  reason: string | null;
  // #404: run_failure carries failureClass + phase so the CLI can mirror the web
  // card — tell an infra/transient hiccup apart from a genuine work failure.
  detail: { question?: string; options?: string[]; failureClass?: string; phase?: string } | null;
  answer: string | null;
  task: { displayNumber: number | null; title: string } | null;
}

export interface ApprovalRow {
  type: "approval";
  id: string;
  status: string;
  target: { kind: string; id: string; label: string } | null;
  approver: { name: string | null; email: string } | null;
  requestedBy: { name: string | null; email: string } | null;
}

// A goal that is "ready to deliver" — surfaced from the unified attention list as a
// LINK-only item (no inline accept; the accept stays on the goal-detail page). The CLI
// renders the accept hint so the operator can deliver it without leaving the terminal.
export interface GoalReadyRow {
  type: "goal_ready";
  goalId: string;
  title: string;
  displayNumber: number | null;
}

// An open risk from the EngineRisk register (cutover P2b-3b) — surfaced from the unified
// attention list as a LINK-only item (no inline resolve; the resolve UI lives on the web
// flags page). The CLI prints it for visibility + points the operator there.
export interface RiskRow {
  type: "risk";
  id: string;
  title: string;
  severity: string;
  /** The goal this risk is anchored to (null for a project-level risk). Printed so
   *  same-titled risks (e.g. several starved goals) are distinguishable + deep-linkable. */
  goalId?: string | null;
  agentAuthored: boolean;
}

// LINK-only attention items the unified list also carries (goal 4fac1d34 + cutover). None is
// resolvable from the terminal — the action lives on the web needs-attention page — so the CLI
// prints each for visibility + points the operator there, the same way goal_ready / risk do.
// Without an explicit branch per type they fall through to `renderPause`, which reads
// kind/task/id those items lack and prints a garbage "pause" line with a dead `answer <id>` hint.
export interface GoalParkedRow {
  type: "goal_parked";
  goalId: string;
  title: string;
  displayNumber: number | null;
  backlogTasks: number;
}
export interface GoalPrDeadRow {
  type: "goal_pr_dead";
  goalId: string;
  title: string;
  displayNumber: number | null;
  prNumber: number | null;
}
export interface DiscussionWaitingRow {
  type: "discussion_waiting";
  taskId: string;
  goalId: string | null;
  title: string;
  displayNumber: number | null;
}
export interface StalledRow {
  type: "stalled";
  taskId: string;
  goalId: string | null;
  title: string;
  displayNumber: number | null;
  runtimeState: string;
}

export type AttentionRow =
  | PauseRow
  | ApprovalRow
  | GoalReadyRow
  | GoalParkedRow
  | GoalPrDeadRow
  | DiscussionWaitingRow
  | StalledRow
  | RiskRow;

/** The 3 bespoke `out_of_band_commit` effects (their own action, not a resume/cancel/waive
 *  resolution — see resolvePause in src/lib/engine/pause.ts). Sent alongside
 *  resolution="resume"; ignored server-side for every other pause kind. */
export type OutOfBandCommitAction = "mark_done_oob" | "continue_lifecycle" | "dismiss";

// Discriminated answer: pause resolutions go to the resolve route; approval
// actions go to the decide route. `target` picks the dispatch. `action` is only ever set
// for the out_of_band_commit flags below — every other pause answer omits it.
export type PauseAnswer = {
  target: "pause";
  pauseId: string;
  resolution: "resume" | "cancel" | "waive";
  answer?: string;
  action?: OutOfBandCommitAction;
};
export type ApprovalAnswer = { target: "approval"; approvalId: string; action: "grant" | "reject"; comment?: string };
export type AnswerArgs = PauseAnswer | ApprovalAnswer;
export type ParseResult =
  // `all` scopes the list: default (false) shows only MY + unowned items — owner-scoped `mine`,
  // matching the web /attention feed; `--all` (true) shows every open item in the project.
  | { ok: true; cmd: "list"; all: boolean }
  | { ok: true; cmd: "answer"; args: AnswerArgs }
  | { ok: false; error: string };

const USAGE =
  "Usage:\n" +
  "  npm run engine:attention                                   # list MY open pauses + approvals (+ unowned)\n" +
  "  npm run engine:attention -- --all                          # list EVERY open item in the project\n" +
  '  npm run engine:attention -- answer <pauseId> "<answer>"    # resume a clarification\n' +
  "  npm run engine:attention -- answer <pauseId> --cancel|--waive\n" +
  "  npm run engine:attention -- answer <pauseId> --mark-done-oob|--continue-lifecycle|--dismiss-oob  # out_of_band_commit pauses\n" +
  "  npm run engine:attention -- answer <approvalId> --approve\n" +
  '  npm run engine:attention -- answer <approvalId> --reject "<reason>"';

/** CLI flag → the `action` it sends (see OutOfBandCommitAction). */
const OOB_ACTION_FLAGS: Record<string, OutOfBandCommitAction> = {
  "--mark-done-oob": "mark_done_oob",
  "--continue-lifecycle": "continue_lifecycle",
  "--dismiss-oob": "dismiss",
};

/**
 * Parse argv: bare (or `list`) → list; `answer <id> …` where the flag selects
 * the action — pause `--cancel`/`--waive`/free-text(resume) or approval
 * `--approve`/`--reject "<reason>"`. A single `<id>` is routed by its flag, so
 * the CLI doesn't need to know up front whether it's a pause or an approval.
 */
export function parseArgs(argv: string[]): ParseResult {
  // `--all` is a list-scope flag, not a subcommand — strip it before subcommand parsing so
  // `engine:attention -- --all` (flag in argv[0]) is recognized. It only affects `list`.
  const all = argv.includes("--all");
  const rest = argv.filter((a) => a !== "--all");
  const sub = rest[0];
  if (sub === undefined || sub === "list") return { ok: true, cmd: "list", all };
  if (sub !== "answer") return { ok: false, error: `Unknown subcommand "${sub}".\n${USAGE}` };

  const id = rest[1];
  if (!id || id.startsWith("--")) return { ok: false, error: `answer needs an <id>.\n${USAGE}` };

  const flag = rest[2];
  if (flag === "--cancel") return { ok: true, cmd: "answer", args: { target: "pause", pauseId: id, resolution: "cancel" } };
  if (flag === "--waive") return { ok: true, cmd: "answer", args: { target: "pause", pauseId: id, resolution: "waive" } };
  if (flag !== undefined && flag in OOB_ACTION_FLAGS) {
    return {
      ok: true,
      cmd: "answer",
      args: { target: "pause", pauseId: id, resolution: "resume", action: OOB_ACTION_FLAGS[flag] },
    };
  }
  if (flag === "--approve") return { ok: true, cmd: "answer", args: { target: "approval", approvalId: id, action: "grant" } };
  if (flag === "--reject") {
    const comment = rest[3];
    if (!comment || comment.startsWith("--")) {
      return { ok: false, error: `--reject needs a "<reason>".\n${USAGE}` };
    }
    return { ok: true, cmd: "answer", args: { target: "approval", approvalId: id, action: "reject", comment } };
  }
  if (flag === undefined || flag.startsWith("--")) {
    return { ok: false, error: `answer needs an answer string or a flag (--cancel/--waive/--approve/--reject).\n${USAGE}` };
  }
  return { ok: true, cmd: "answer", args: { target: "pause", pauseId: id, resolution: "resume", answer: flag } };
}

function renderPause(p: PauseRow): string {
  const task = p.task ? `${p.task.displayNumber != null ? `#${p.task.displayNumber} ` : ""}${p.task.title}` : "(no task)";
  const q = p.detail?.question ?? p.reason ?? "";
  const opts = p.detail?.options?.length ? `\n     options: ${p.detail.options.join(" | ")}` : "";
  // #404: for a run_failure, tag the class + failing phase so an infra/transient
  // hiccup (safe to retry) is distinguishable from a genuine work failure.
  const tag =
    p.kind === "run_failure"
      ? `[run_failure:${p.detail?.failureClass ?? "task"}${p.detail?.phase ? `/${p.detail.phase}` : ""}]`
      : `[${p.kind}]`;
  return `  • ${tag} ${task}\n     pause ${p.id}\n     ${q}${opts}`;
}

function renderApproval(a: ApprovalRow): string {
  const target = a.target ? a.target.label : "(no target)";
  const who = a.requestedBy?.name ?? a.requestedBy?.email ?? "someone";
  const appr = a.approver?.name ?? a.approver?.email ?? "—";
  return `  • [approval:${a.target?.kind ?? "?"}] ${target}\n     approval ${a.id}\n     requested by ${who} · approver ${appr}`;
}

function renderGoalReady(g: GoalReadyRow): string {
  const num = g.displayNumber != null ? `#${g.displayNumber} ` : "";
  return (
    `  • [ready] Goal ${num}${g.title} — ready to deliver\n` +
    `     accept with: npm run engine:goal -- accept ${g.goalId}`
  );
}

function renderRisk(r: RiskRow): string {
  const who = r.agentAuthored ? "agent-raised" : "raised";
  const goalLine = r.goalId ? `\n     goal ${r.goalId}` : "";
  return (
    `  • [risk:${r.severity}] ${r.title} (${who})\n` +
    `     risk ${r.id}${goalLine}\n` +
    `     open — review & resolve on the project's Flags page`
  );
}

const numbered = (displayNumber: number | null, title: string): string =>
  `${displayNumber != null ? `#${displayNumber} ` : ""}${title}`;

function renderGoalParked(g: GoalParkedRow): string {
  return (
    `  • [parked] Goal ${numbered(g.displayNumber, g.title)} — ${g.backlogTasks} task(s) parked, waiting to resume\n` +
    `     goal ${g.goalId}\n` +
    `     resume on the project's needs-attention page`
  );
}

function renderGoalPrDead(g: GoalPrDeadRow): string {
  const pr = g.prNumber != null ? ` (PR #${g.prNumber})` : "";
  return (
    `  • [pr_dead] Goal ${numbered(g.displayNumber, g.title)} — PR closed without delivering${pr}\n` +
    `     goal ${g.goalId}\n` +
    `     review on the project's needs-attention page`
  );
}

function renderDiscussionWaiting(d: DiscussionWaitingRow): string {
  return (
    `  • [discussion] ${numbered(d.displayNumber, d.title)} — awaiting your reply\n` +
    `     task ${d.taskId}${d.goalId ? `\n     goal ${d.goalId}` : ""}\n` +
    `     respond on the web (the conversation lives on the task page)`
  );
}

function renderStalled(s: StalledRow): string {
  return (
    `  • [stalled:${s.runtimeState}] ${numbered(s.displayNumber, s.title)} — no progress; may be wedged\n` +
    `     task ${s.taskId}${s.goalId ? `\n     goal ${s.goalId}` : ""}\n` +
    `     investigate on the web — re-drive or cancel`
  );
}

// Defensive fallback for a future server item type the CLI doesn't model yet — print a
// minimal, honest line rather than letting it masquerade as a pause (the bug this fixes).
function renderUnknown(it: { type?: string; id?: string; title?: string }): string {
  return `  • [${it.type ?? "?"}] ${it.title ?? it.id ?? "(item)"}\n     view on the project's needs-attention page`;
}

/** Render the open attention list — pauses + approvals + every link-only item type. */
export function renderList(items: AttentionRow[]): string {
  if (items.length === 0) return "[engine-attention] No open attention items.\n";
  const lines = items.map((it) => {
    switch (it.type) {
      case "goal_ready": return renderGoalReady(it);
      case "goal_parked": return renderGoalParked(it);
      case "goal_pr_dead": return renderGoalPrDead(it);
      case "discussion_waiting": return renderDiscussionWaiting(it);
      case "stalled": return renderStalled(it);
      case "risk": return renderRisk(it);
      case "approval": return renderApproval(it);
      case "pause":
      case undefined:
        return renderPause(it);
      default:
        return renderUnknown(it as unknown as { type?: string; id?: string; title?: string });
    }
  });
  return (
    `[engine-attention] ${items.length} open item(s):\n${lines.join("\n\n")}\n\n` +
    `Pauses:    npm run engine:attention -- answer <id> "<answer>" | --cancel | --waive\n` +
    `           out_of_band_commit pauses: --mark-done-oob | --continue-lifecycle | --dismiss-oob\n` +
    `Approvals: npm run engine:attention -- answer <id> --approve | --reject "<reason>"\n`
  );
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function listPauses(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  opts: { all?: boolean } = {},
): Promise<AttentionRow[]> {
  // Default = owner-scoped `mine` (server default: my + unowned items). `--all` opts into the
  // full project list via `owner=all`. Omit the param on the default so the server's default owns
  // the scope (no client/server drift).
  const ownerParam = opts.all ? "&owner=all" : "";
  const res = await fetchFn(
    `${cfg.baseUrl}/api/v1/me/engine/pauses?projectId=${encodeURIComponent(cfg.projectId)}${ownerParam}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(await errMsg(res, "List failed"));
  const parsed = (await res.json().catch(() => null)) as { data?: AttentionRow[] } | null;
  return parsed?.data ?? [];
}

/**
 * Retry helper for mutating (POST) attention calls. Retries once on a 5xx response or
 * a network-level fetch() throw (connection reset, timeout). 4xx responses are NOT
 * retried — the server explicitly rejected the answer and retrying would duplicate it.
 *
 * On a second network failure, warns the operator that the answer may or may not have
 * been recorded (the server could have received the first request before the reset) and
 * re-throws so the caller exits 1. On a second 5xx failure, returns the bad response so
 * errMsg can surface the body; the caller throws.
 */
export async function retryMutate(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  label: string,
  delayMs = 1000,
): Promise<Response> {
  const RETRY_DELAY_MS = delayMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (networkErr) {
      if (attempt === 0) {
        process.stderr.write(`[engine-attention] ${label}: network error, retrying in 1s…\n`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      process.stderr.write(
        `[engine-attention] ${label}: network error on retry — the answer MAY OR MAY NOT have been recorded. Verify manually.\n`,
      );
      throw networkErr;
    }
    // 4xx: explicit rejection — don't retry.
    if (res.status >= 400 && res.status < 500) return res;
    // 5xx: transient — retry once.
    if (res.status >= 500 && attempt === 0) {
      process.stderr.write(`[engine-attention] ${label}: server returned ${res.status}, retrying in 1s…\n`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    return res;
  }
  throw new Error("unreachable");
}

/**
 * Client-side guard for the out_of_band_commit action flags: mirrors the server's
 * waive-is-only-for-review_standoff guard, but done here since `listPauses()` already
 * returns each pause's `kind` — no reason to round-trip a mutating POST just to have the
 * server reject it. Only runs when `args.action` is set (every other answer skips it).
 */
export async function assertOutOfBandCommitKind(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  pauseId: string,
): Promise<void> {
  // Look up by id across ALL owners — this is a pre-flight kind check on a pause the operator
  // named explicitly, not a display list, so it must not be owner-scoped (else answering another
  // owner's out_of_band_commit pause would skip the guard).
  const items = await listPauses(fetchFn, cfg, token, { all: true });
  const pause = items.find(
    (it): it is PauseRow => (it.type === undefined || it.type === "pause") && "id" in it && it.id === pauseId,
  );
  if (pause && pause.kind !== "out_of_band_commit") {
    throw new Error(
      `--mark-done-oob/--continue-lifecycle/--dismiss-oob are only valid for an out_of_band_commit pause, ` +
        `not a ${pause.kind} pause (${pauseId}).`,
    );
  }
  // Not found: let the resolve POST run and surface the server's own 404 — this guard only
  // rejects a KNOWN kind mismatch, it doesn't duplicate not-found handling.
}

export async function answerPause(fetchFn: FetchFn, cfg: SyncConfig, token: string, args: PauseAnswer): Promise<void> {
  if (args.action) await assertOutOfBandCommitKind(fetchFn, cfg, token, args.pauseId);
  const res = await retryMutate(
    fetchFn,
    `${cfg.baseUrl}/api/v1/me/engine/pauses/${args.pauseId}/resolve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        resolution: args.resolution,
        ...(args.answer ? { answer: args.answer } : {}),
        ...(args.action ? { action: args.action } : {}),
      }),
    },
    "answerPause",
  );
  if (!res.ok) throw new Error(await errMsg(res, "Answer failed"));
}

export async function decideApproval(fetchFn: FetchFn, cfg: SyncConfig, token: string, args: ApprovalAnswer): Promise<void> {
  const res = await retryMutate(
    fetchFn,
    `${cfg.baseUrl}/api/v1/me/engine/approvals/${args.approvalId}/decide`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: args.action, ...(args.comment ? { comment: args.comment } : {}) }),
    },
    "decideApproval",
  );
  if (!res.ok) throw new Error(await errMsg(res, "Decide failed"));
}

/** Dispatch an answer to the right route by its `target` discriminator. */
export async function submitAnswer(fetchFn: FetchFn, cfg: SyncConfig, token: string, args: AnswerArgs): Promise<void> {
  if (args.target === "approval") return decideApproval(fetchFn, cfg, token, args);
  return answerPause(fetchFn, cfg, token, args);
}

export async function errMsg(res: Response, prefix: string): Promise<string> {
  let msg = `${prefix}: ${res.status}`;
  try {
    const b = (await res.json()) as { message?: string; error?: string };
    if (b?.message) msg += ` — ${b.message}`;
    else if (b?.error) msg += ` — ${b.error}`;
  } catch {
    // Non-JSON body — append the raw text so the operator sees the actual server error.
    try {
      const text = await res.text();
      if (text) msg += ` — ${text.slice(0, 500)}`;
    } catch {
      /* ignore */
    }
  }
  return msg;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`[engine-attention] ${parsed.error}\n`);
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-attention] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-attention] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    if (parsed.cmd === "list") {
      process.stdout.write(renderList(await listPauses(fetch, cfg, token, { all: parsed.all })));
    } else {
      await submitAnswer(fetch, cfg, token, parsed.args);
      const done =
        parsed.args.target === "approval"
          ? `Decided approval ${parsed.args.approvalId} (${parsed.args.action}).`
          : `Resolved pause ${parsed.args.pauseId} (${parsed.args.action ?? parsed.args.resolution}).`;
      process.stdout.write(`[engine-attention] ${done}\n`);
    }
  } catch (err) {
    process.stderr.write(`[engine-attention] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-attention.ts"))) {
  void run();
}
