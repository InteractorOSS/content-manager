#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Interactive engine-report / completion vehicle (cutover C1b-2).
 *
 * Reports the outcome of the interactive EngineRun the developer claimed with
 * `npm run engine:claim` (C1b-1): POSTs to the run-report endpoint, which drives
 * the task forward (advance phase / complete / pause), then clears the local
 * `.tasks/.engine` so the next `engine:claim` isn't blocked by its double-claim
 * guard. Completes the terminal loop: claim → work in `claude` → pm_submit_artifact
 * → report.
 *
 * Usage:
 *   npm run engine:report                 # report the run succeeded
 *   npm run engine:report -- --fail "why" # report failed → release the task
 *   npm run engine:report -- --abandon    # alias for --fail with a default reason
 *
 * Credential: the daemon token in PM_DAEMON_TOKEN (same as engine:claim — the
 * report route takes a daemon token or a browser session, not the sync token).
 * The runId is read from `.tasks/.engine`; the deliverable artifact is submitted
 * separately during the session via the bridge's pm_submit_artifact.
 */

import * as fs from "fs";
import * as path from "path";
import { resolveSyncFile, loadDaemonToken } from "./engine-claim";

// Vendored: product-manager's Prisma client generates `runtime_state` as a plain
// string-literal enum; inlining the one value used here avoids requiring
// content-management's own @prisma/client to know about PM's engine schema.
const runtime_state = { backlog: "backlog" } as const;

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface EngineRunContext {
  projectId: string;
  runId: string;
  taskId: string;
  phase: string;
}

/** Parse `.tasks/.engine` (written by engine:claim / the daemon) — validates the
 *  documented { projectId, runId, taskId, phase } shape rather than a bare parse. */
export function parseEngineContext(content: string): EngineRunContext | null {
  try {
    const raw = JSON.parse(content) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (
      typeof o.projectId !== "string" ||
      typeof o.runId !== "string" ||
      typeof o.taskId !== "string" ||
      typeof o.phase !== "string"
    ) {
      return null;
    }
    return { projectId: o.projectId, runId: o.runId, taskId: o.taskId, phase: o.phase };
  } catch {
    return null;
  }
}

export type ReportOutcome = "succeeded" | "failed";

// The report route returns several 200 shapes — some WITHOUT a `drive` key.
export interface ReportData {
  run?: { id?: string; status?: string };
  drive?: {
    pausedForRisk?: boolean;
    // Cutover C2a: an interactive investigation→execution advance withheld for human
    // spec approval. The route still reports decision.action="advance_phase" with
    // applied=false, so formatResult must branch on these BEFORE the action switch
    // or it mislabels a paused task as "Advanced".
    pausedForSpecApproval?: boolean;
    // Whether the decision was actually applied. A withheld advance (risk/spec-approval
    // pause) has applied=false; never report it as a completed advance.
    applied?: boolean;
    // #464: the runtime state the task landed in on an applied advance/kickback. A
    // `manual` project re-queues to "backlog" (daemon-invisible — `engine:claim`
    // can't see it), "queued" otherwise. Undefined from an older route ⇒ assume queued.
    runtimeState?: string;
    // #464: the task's display number, for the next-step command copy.
    displayNumber?: number | null;
    decision?: { action?: string; to?: string; reason?: string; iteration?: number };
  };
  reviewStandoff?: boolean;
  standoffs?: number;
  operatorActionRequired?: boolean;
  clarification?: boolean;
  paused?: boolean;
  alreadyReported?: boolean;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** POST the run report. Throws on a non-OK response. Returns the route's `data`. */
export async function reportRun(
  fetchFn: FetchFn,
  baseUrl: string,
  runId: string,
  token: string,
  outcome: ReportOutcome,
  error?: string,
): Promise<ReportData> {
  const body: Record<string, unknown> = { outcome };
  if (outcome === "failed") body.error = error ?? "abandoned";
  const res = await fetchFn(`${baseUrl}/api/v1/me/engine/runs/${runId}/report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Report failed: ${res.status}`);
  }
  const json = (await res.json()) as { data: ReportData };
  return json.data;
}

/**
 * The next-step clause after an applied re-queue (advance / kickback), #464.
 * WHERE the task landed decides the command:
 *  - `backlog` (manual project, daemon-invisible) ⇒ `engine:claim` can't see it, so
 *    point at promoting it (`engine:queue`) or working it directly (`engine:work`).
 *  - `queued` / unknown / older route ⇒ `engine:claim`, the no-arg claim vehicle.
 * Uses a BARE display number (`-- 7`, not `-- #7`): `#7` is a shell comment in
 * zsh/bash and would be silently dropped on copy-paste; the resolver accepts both.
 */
function nextStepHint(runtimeState: string | undefined, displayNumber: number | null | undefined): string {
  if (runtimeState === runtime_state.backlog) {
    const idArg = displayNumber != null ? ` -- ${displayNumber}` : "";
    return `parked in backlog (manual project) — promote it with \`npm run engine:queue${idArg}\` or keep driving it with \`npm run engine:work${idArg}\``;
  }
  return "task re-queued; claim the next phase with `npm run engine:claim`";
}

/**
 * Human-readable consequence of the report, branching on RESPONSE SHAPE — the
 * route omits `drive` on the paused / standoff / operator-action / already-
 * reported paths, so never assume it's present.
 */
export function formatResult(data: ReportData): string {
  if (data.alreadyReported) return `Run already reported (${data.run?.status ?? "closed"}).`;
  if (data.reviewStandoff) {
    return `Paused: review standoff (${data.standoffs ?? "?"} contested finding(s)) — resolve on /attention.`;
  }
  if (data.operatorActionRequired) return `Paused: operator action required — see /attention.`;
  // Latent today (engine:report only sends succeeded/failed), but the route can
  // return this for an agent-raised clarification — handle it so the copy is
  // right when C1c wires clarifications through.
  if (data.clarification) return `Paused: clarification requested — answer on /attention.`;

  const drive = data.drive;
  if (drive) {
    if (drive.pausedForRisk) return `Paused: high-risk change needs confirmation — /attention.`;
    // A withheld investigation→execution advance: the task is PAUSED awaiting human
    // spec approval, NOT advanced. Must precede the action switch — decision.action
    // is still "advance_phase" here (with applied=false).
    if (drive.pausedForSpecApproval) {
      return `Paused: spec approval required — approve with \`npm run engine:approve\` (or resolve on /attention).`;
    }
    const d = drive.decision;
    switch (d?.action) {
      case "advance_phase":
        // Defensive: any other withheld advance (applied=false without a known pause
        // flag above) must not read as a completed advance — the task is held, not moved.
        if (drive.applied === false) {
          return `Advance to ${d.to} withheld — task is paused; check \`npm run engine:status\`.`;
        }
        // Genuine advance: the run context is cleared and the task is re-queued. The
        // next step depends on WHERE it landed (#464) — see nextStepHint.
        return `Advanced to ${d.to} — ${nextStepHint(drive.runtimeState, drive.displayNumber)}.`;
      case "complete":
        return `Task complete.`;
      case "kickback":
        // A kickback also re-queues (→ backlog on a manual project), so it gets the
        // same mode-aware continuation guidance as an advance (#464).
        return `Kicked back to ${d.to} (iteration ${d.iteration}) — ${nextStepHint(drive.runtimeState, drive.displayNumber)}.`;
      case "pause":
        return `Paused: ${d.reason ?? "kickback cap"} — /attention.`;
      default:
        return `Reported${d?.action ? ` — ${d.action}` : ""} (${data.run?.status ?? "ok"}).`;
    }
  }

  if (data.paused) return `Released — task paused for a human.`; // the --fail branch
  return `Reported (${data.run?.status ?? "ok"}).`;
}

/** Parse argv → outcome + optional failure reason. */
export function parseArgs(args: string[]): { outcome: ReportOutcome; error?: string } {
  const idx = args.findIndex((a) => a === "--fail" || a === "--abandon");
  if (idx === -1) return { outcome: "succeeded" };
  const next = args[idx + 1];
  const error = next && !next.startsWith("--") ? next : "abandoned";
  return { outcome: "failed", error };
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

function fail(msg: string): never {
  process.stderr.write(`[engine-report] ${msg}\n`);
  process.exit(1);
}

async function run(): Promise<void> {
  const cwd = process.cwd();
  const { outcome, error } = parseArgs(process.argv.slice(2));

  const enginePath = path.join(cwd, ".tasks", ".engine");
  if (!fs.existsSync(enginePath)) {
    fail("no engine run in progress (.tasks/.engine absent) — claim one with `npm run engine:claim`.");
  }
  const ctx = parseEngineContext(fs.readFileSync(enginePath, "utf8"));
  if (!ctx) fail("malformed .tasks/.engine — expected { projectId, runId, taskId, phase }.");

  const resolved = resolveSyncFile(cwd);
  if (!resolved) fail("No sync file found (checked .build/.sync and .tasks/.sync).");
  const sync = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  let data: ReportData;
  try {
    data = await reportRun(fetch, sync.baseUrl, ctx.runId, token, outcome, error);
  } catch (err) {
    // Don't clear .tasks/.engine on a failed POST — the run wasn't reported.
    fail(err instanceof Error ? err.message : String(err));
  }

  // Terminal response (success or already-reported) — clear the run context so
  // the next `engine:claim` isn't blocked by its double-claim guard.
  fs.rmSync(enginePath, { force: true });
  process.stdout.write(`[engine-report] ${formatResult(data)} (.tasks/.engine cleared)\n`);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-report.ts"))) {
  void run();
}
