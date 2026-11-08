#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local interactive engine-claim vehicle (cutover C1b-1).
 *
 * Claims the next runnable EngineTask for the current project as an INTERACTIVE
 * EngineRun (mode=interactive) — the terminal counterpart to the daemon's
 * headless claim. Writes `.tasks/.current` + `.tasks/.engine` so that when the
 * developer then starts `claude`, the unified PM bridge registers a session and
 * C1a (linkSession) links it to the run (populating EngineRun.sessionId). The
 * claim itself carries no sessionId — C1a does the linking post-launch.
 *
 * Credential: a daemon token (`pm_daemon_…`, account-level) in PM_DAEMON_TOKEN —
 * the claim route (/api/v1/me/engine/claim) takes a daemon token or a browser
 * session, NOT the project sync token, and a local script has no browser cookie.
 * Mint one in the PM UI (Settings → Agent Tokens) and put it in .env.local.
 *
 * Usage:
 *   npm run engine:claim          # claim the next runnable task interactively
 *   npm run engine:claim -- --force   # claim even if .tasks/.engine exists
 *
 * Then start `claude`, do the phase work, `pm_submit_artifact` the deliverable,
 * and report done (see .claude/commands/i/engine-claim.md).
 */

import * as fs from "fs";
import * as path from "path";
import { parseSyncFile, resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-config";
import { reapBestEffort } from "./engine-reap";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

// Moved to engine-config.ts (goal fe6d12af) to break a cycle with engine-reap.ts,
// which this file now calls into — re-exported so every existing importer of
// `parseSyncFile`/`loadDaemonToken`/`SyncConfig` from "./engine-claim" is unaffected.
// `resolveSyncFile` re-exported too so downstream files can import it from either module.
export { parseSyncFile, resolveSyncFile, loadDaemonToken, type SyncConfig };

/** Refuse to claim over an existing run context unless --force (cutover C1b-1). */
export function guardDoubleClaim(engineFileExists: boolean, force: boolean): void {
  if (engineFileExists && !force) {
    throw new Error(
      "An engine run context already exists at .tasks/.engine — refusing to claim a second " +
        "run (it would orphan the first as stuck-running). Finish/report that run, remove " +
        ".tasks/.engine, or re-run with --force.",
    );
  }
}

export interface ClaimedTask {
  id: string;
  displayNumber: number | null;
  title: string;
  phase: string;
}
export interface ClaimedRun {
  id: string;
  phase: string;
}
export interface ClaimData {
  projectId: string;
  task: ClaimedTask;
  run: ClaimedRun;
  // `integration.goalId` is attached by the server on code phases (the goal that owns
  // the branch/PR); used to stage the goal's attachments at seed time without a second
  // round-trip. Absent on read/planning phases.
  // `systemPrefix` is the goal-stable cached prefix the daemon feeds the agent BEFORE
  // the prompt body — since G#339 a planning task's goal objective lives there, so a
  // terminal driver that drops it sees a prompt that looks objective-less.
  phaseJob?: { prompt?: string; systemPrefix?: string; integration?: { goalId?: string } };
}

/**
 * Render the phase-job block the CLIs print after the claim banner: the
 * `systemPrefix` (when non-empty) in its own delimited section, then the prompt
 * body — mirroring the order the daemon composes them for the agent. Empty/absent
 * parts are omitted entirely (no bare delimiters); neither part → "".
 */
export function renderPhaseJobBlock(phaseJob?: ClaimData["phaseJob"]): string {
  return (
    (phaseJob?.systemPrefix ? `\n--- system prefix ---\n${phaseJob.systemPrefix}\n` : "") +
    (phaseJob?.prompt ? `\n--- phase prompt ---\n${phaseJob.prompt}\n` : "")
  );
}

/** `.tasks/.current` — task context the bridge attaches to its session. */
export function buildCurrentTask(task: ClaimedTask): string {
  return JSON.stringify({
    taskId: task.id,
    taskDisplayNumber: task.displayNumber,
    taskTitle: task.title,
    startedVia: "local_command",
  });
}

/** `.tasks/.engine` — engine run context the bridge reads (mirrors the daemon's shape). */
export function buildEngineContext(projectId: string, run: ClaimedRun, task: ClaimedTask): string {
  return JSON.stringify({ projectId, runId: run.id, taskId: task.id, phase: task.phase });
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST an interactive claim. Returns the claim data, or null when nothing is
 * runnable. Throws on a non-OK response.
 */
export async function claimInteractiveRun(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
): Promise<ClaimData | null> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "interactive", projectIds: [cfg.projectId] }),
  });
  if (!res.ok) {
    throw new Error(`Claim failed: ${res.status}`);
  }
  const body = (await res.json()) as { data: ClaimData | null };
  return body.data ?? null;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

function main(): void {
  void run();
}

async function run(): Promise<void> {
  const cwd = process.cwd();

  // Best-effort preflight (goal fe6d12af): see the matching call in engine-work.ts.
  await reapBestEffort(cwd);

  const force = process.argv.includes("--force");

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-claim] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
    guardDoubleClaim(fs.existsSync(path.join(cwd, ".tasks", ".engine")), force);
  } catch (err) {
    process.stderr.write(`[engine-claim] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let data: ClaimData | null;
  try {
    data = await claimInteractiveRun(fetch, cfg, token);
  } catch (err) {
    process.stderr.write(`[engine-claim] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if (!data) {
    process.stdout.write("[engine-claim] Nothing runnable to claim.\n");
    process.exit(0);
  }

  fs.mkdirSync(path.join(cwd, ".tasks"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".tasks", ".current"), buildCurrentTask(data.task));
  fs.writeFileSync(path.join(cwd, ".tasks", ".engine"), buildEngineContext(data.projectId, data.run, data.task));

  const n = data.task.displayNumber != null ? `#${data.task.displayNumber} ` : "";
  process.stdout.write(
    `[engine-claim] Claimed ${n}${data.task.title} (${data.task.phase}) — run ${data.run.id} [interactive].\n` +
      `\nNext: start \`claude\` here. The PM bridge will register a session and link it to the run.\n` +
      `Submit the deliverable with pm_submit_artifact; report done per .claude/commands/i/engine-claim.md.\n` +
      renderPhaseJobBlock(data.phaseJob),
  );
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-claim.ts"))) {
  main();
}
