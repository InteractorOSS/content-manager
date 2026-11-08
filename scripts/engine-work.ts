#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local user-driven "work this task" vehicle (engine-work, T327).
 *
 * The terminal counterpart to the legacy `/i/task-go`, for the engine: a developer
 * picks a SPECIFIC engine task by identifier (#N / slug / title-fragment) and opens
 * an INTERACTIVE EngineRun on exactly that task — bypassing the automation queue
 * (`engine:claim`/`claimNext`, which pops the next queued task). Unlike the daemon,
 * the user may open ANY non-terminal task (queued/paused/blocked); opening a blocked
 * task deliberately overrides its dependency gate.
 *
 * Flow: resolve the identifier (GET /me/engine/resolve) → on `found`, open the run
 * (POST /me/engine/claim { taskId, projectId }) → write `.tasks/.current` +
 * `.tasks/.engine` (so the PM bridge links the `claude` session via C1a) → print the
 * phase prompt. On `ambiguous`/`not_found`, print candidates/suggestions and open
 * NOTHING.
 *
 * Credential: a daemon token (PM_DAEMON_TOKEN), same as `engine:claim`.
 *
 * Usage:
 *   npm run engine:work -- 42            # by display number
 *   npm run engine:work -- my-task-slug  # by slug
 *   npm run engine:work -- "fix login"   # by title fragment
 *   npm run engine:work -- <uuid>        # by raw task id (claims directly)
 *   npm run engine:work -- 42 --force    # open even if .tasks/.engine exists OR the
 *                                        #   goal is already actively driven (S2 lock)
 */

import * as fs from "fs";
import * as path from "path";
import {
  buildCurrentTask,
  buildEngineContext,
  guardDoubleClaim,
  loadDaemonToken,
  resolveSyncFile,
  renderPhaseJobBlock,
  type ClaimData,
  type SyncConfig,
} from "./engine-claim";
import {
  type BranchSource,
  deriveBranchName,
  ensureWorktree,
  gitDirs,
  isLinkedWorktree,
  seedWorktree,
  worktreePathFor,
} from "./engine-worktree";
import { stageGoalAttachments } from "./engine-goal-files";
import { reapBestEffort } from "./engine-reap";
import { execFileSync } from "child_process";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface ResolvedTaskSummary {
  id: string;
  displayNumber: number | null;
  slug: string | null;
  title: string;
  runtimeState: string;
  phase: string;
  type: string;
}

export type EngineTaskResolution =
  | { kind: "found"; task: ResolvedTaskSummary; via: string }
  | { kind: "ambiguous"; matches: ResolvedTaskSummary[] }
  | { kind: "not_found"; suggestions: ResolvedTaskSummary[] };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Pull the identifier (first non-flag arg) + the --force / --no-worktree flags from argv. */
export function parseArgs(argv: string[]): { identifier: string | null; force: boolean; noWorktree: boolean } {
  const rest = argv.slice(2);
  const force = rest.includes("--force");
  // #440: interactive engine work is isolated in a per-goal git worktree by
  // default; --no-worktree is a discouraged escape hatch for working in place.
  const noWorktree = rest.includes("--no-worktree");
  const identifier = rest.find((a) => !a.startsWith("--")) ?? null;
  return { identifier, force, noWorktree };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for a bare task UUID. The server resolver matches `#N` / slug /
 * title-substring but NOT a raw id, so `engine:create` printing only the UUID
 * (when displayNumber is null) left no resolvable handle — `engine:work <uuid>`
 * fell to not-found. A UUID is unambiguous, so we skip resolve and claim it
 * directly.
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Render a one-line summary of a task for candidate/suggestion lists. */
export function summaryLine(t: ResolvedTaskSummary): string {
  const n = t.displayNumber != null ? `#${t.displayNumber} ` : "";
  const slug = t.slug ? ` (${t.slug})` : "";
  return `  ${n}${t.title}${slug} — ${t.runtimeState}/${t.phase}`;
}

/** GET /me/engine/resolve — resolve an identifier to a task (or ambiguity/not-found). */
export async function resolveTask(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  identifier: string,
): Promise<EngineTaskResolution> {
  const url = `${cfg.baseUrl}/api/v1/me/engine/resolve?projectId=${encodeURIComponent(cfg.projectId)}&identifier=${encodeURIComponent(identifier)}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
  const body = (await res.json()) as { data: EngineTaskResolution };
  return body.data;
}

/**
 * GET /me/engine/tasks/:id — fetch the task's goal context so we can name the
 * per-goal worktree branch (#440). Returns just the branch-naming subset; throws
 * on a non-OK response.
 */
export async function fetchBranchSource(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  taskId: string,
): Promise<BranchSource> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Task fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: BranchSource };
  return body.data;
}

/**
 * POST /me/engine/claim { taskId, projectId } — open an interactive run on a chosen task.
 * `force` (S2) overrides the server-side initiative lock so a run opens even on a goal
 * already actively driven by another session.
 */
export async function claimSpecificRun(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  taskId: string,
  force = false,
): Promise<ClaimData> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, projectId: cfg.projectId, force }),
  });
  if (!res.ok) {
    let msg = `Claim failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; details?: string[] };
      if (b?.message) msg += ` — ${b.message}`;
      // Initiative collision (409): list each active driver so the operator can see
      // exactly who to coordinate with, then re-run with --force if intended.
      if (Array.isArray(b?.details) && b.details.length > 0) {
        msg += "\n" + b.details.map((d) => `  • ${d}`).join("\n");
      }
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const body = (await res.json()) as { data: ClaimData };
  return body.data;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  // Best-effort preflight (goal fe6d12af): sweep terminal-goal worktrees/branches
  // before doing anything else, so the loop self-heals on every invocation instead
  // of relying on someone remembering `engine:finish`. Never blocks this command.
  await reapBestEffort(cwd);

  const { identifier, force, noWorktree } = parseArgs(process.argv);

  if (!identifier) {
    process.stderr.write(
      "[engine-work] Usage: npm run engine:work -- <#N | slug | title-fragment> [--force] [--no-worktree]\n",
    );
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-work] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-work] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // A raw task UUID can't be matched by the #N/slug/title resolver — claim it
  // directly. Otherwise resolve first, surfacing ambiguity/not-found WITHOUT
  // opening anything.
  let taskId: string;
  if (isUuid(identifier)) {
    taskId = identifier;
  } else {
    let resolution: EngineTaskResolution;
    try {
      resolution = await resolveTask(fetch, cfg, token, identifier);
    } catch (err) {
      process.stderr.write(`[engine-work] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (resolution.kind === "ambiguous") {
      process.stderr.write(
        `[engine-work] "${identifier}" matches ${resolution.matches.length} tasks — be more specific:\n` +
          resolution.matches.map(summaryLine).join("\n") +
          "\n",
      );
      process.exit(1);
    }
    if (resolution.kind === "not_found") {
      const sugg = resolution.suggestions.length
        ? `\nDid you mean:\n${resolution.suggestions.map(summaryLine).join("\n")}\n`
        : "\n";
      process.stderr.write(`[engine-work] No engine task matches "${identifier}".${sugg}`);
      process.exit(1);
    }
    taskId = resolution.task.id;
  }

  // #440: interactive work is ISOLATED in a per-goal git worktree. In the PRIMARY
  // clone (git-dir === common-dir) we create/reuse the task's goal worktree, seed
  // it, and put the run context THERE — so a run can never tangle with the shared
  // clone (the root cause of the PR #1041 branch collision). Already inside a
  // worktree, or with the discouraged --no-worktree escape hatch, we work in place.
  // Decide the destination (a per-goal worktree, or in-place) WITHOUT side effects
  // yet, so the double-claim guard below can run before we create anything — a
  // tripped guard must never leave an orphaned worktree behind.
  let destDir = cwd;
  let pendingWorktree: { toplevel: string; branch: string; wtPath: string } | null = null;
  if (!noWorktree) {
    try {
      const { gitDir, gitCommonDir } = gitDirs(cwd);
      if (!isLinkedWorktree(gitDir, gitCommonDir)) {
        const branchSrc = await fetchBranchSource(fetch, cfg, token, taskId);
        const branch = deriveBranchName(branchSrc);
        const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
        const wtPath = worktreePathFor(toplevel, branch);
        destDir = wtPath;
        pendingWorktree = { toplevel, branch, wtPath };
      }
    } catch (err) {
      process.stderr.write(
        `[engine-work] worktree setup failed: ${err instanceof Error ? err.message : String(err)}\n` +
          `Re-run with --no-worktree to work in place (discouraged).\n`,
      );
      process.exit(1);
    }
  }

  // Guard against opening a second run over an existing one — checked against the
  // DESTINATION (the worktree we'll write into). Runs BEFORE worktree creation so
  // a trip can't orphan a freshly-made worktree.
  try {
    guardDoubleClaim(fs.existsSync(path.join(destDir, ".tasks", ".engine")), force);
  } catch (err) {
    process.stderr.write(`[engine-work] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Guard passed — now actually create/reuse + seed the worktree.
  let worktreeNote = "";
  if (pendingWorktree) {
    try {
      const { toplevel, branch, wtPath } = pendingWorktree;
      const { created } = ensureWorktree(toplevel, branch, wtPath);
      seedWorktree(toplevel, wtPath);
      worktreeNote =
        `\n${created ? "Created" : "Reusing"} worktree on \`${branch}\` at:\n  ${wtPath}\n` +
        `\n⚠️  Run the rest of this task FROM THE WORKTREE — \`cd ${wtPath}\` before starting \`claude\`.\n`;
    } catch (err) {
      process.stderr.write(
        `[engine-work] worktree setup failed: ${err instanceof Error ? err.message : String(err)}\n` +
          `Re-run with --no-worktree to work in place (discouraged).\n`,
      );
      process.exit(1);
    }
  }

  // Open the interactive run on that specific task (the claim's 404/409 surfaces
  // a clean message if a raw UUID is wrong or already running).
  let data: ClaimData;
  try {
    data = await claimSpecificRun(fetch, cfg, token, taskId, force);
  } catch (err) {
    process.stderr.write(`[engine-work] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(destDir, ".tasks"), { recursive: true });
  fs.writeFileSync(path.join(destDir, ".tasks", ".current"), buildCurrentTask(data.task));
  fs.writeFileSync(path.join(destDir, ".tasks", ".engine"), buildEngineContext(data.projectId, data.run, data.task));

  // Parity with the fleet daemon (docker/agent/daemon/goal-attachments.ts): stage the
  // goal's attachments into the worktree at seed time so `claude` opens specs/mockups
  // by path with no extra step, and so the engine:goal-files reader sees the identical
  // .tasks/attachments/<goalId>/ + index.json layout here and on the fleet. Best-effort:
  // a failure writes a .UNREADABLE sentinel and prints a note, but never fails the run
  // (the worktree is already usable). A goal with no attachments is a no-op.
  let attachmentsNote = "";
  try {
    const stage = await stageGoalAttachments(
      fetch,
      cfg,
      token,
      {
        goalId: data.phaseJob?.integration?.goalId ?? null,
        taskId,
        attachmentsRoot: path.join(destDir, ".tasks", "attachments"),
      },
      fs,
    );
    if (stage.staged > 0) {
      attachmentsNote = `\nStaged ${stage.staged} goal attachment(s) under .tasks/attachments/${stage.goalId}/\n`;
    } else if (stage.credsFailure) {
      // #904: a 401/403 — this token can't read the goal's attachments. The goal references a
      // spec/mockup the run NEEDS; starting `claude` now would only wedge it (it can't read the
      // attachment) into a design_discussion. Fail loud here so the operator fixes creds FIRST
      // rather than launching a doomed run. (The fleet daemon fails such a run as a retryable
      // infra run_failure; interactively we stop with a clear, actionable error.)
      process.stderr.write(
        `\n❌ Cannot stage this goal's attachments — ${stage.reason ?? "missing attachment-capable creds (401/403)"}.\n` +
          `   This goal has attachments the run must read. Provision a daemon token with attachment\n` +
          `   access (PM_DAEMON_TOKEN), then re-run \`npm run engine:work -- ${taskId}\`. Do NOT start\n` +
          `   \`claude\` without the attachments — it would wedge unable to read the spec.\n`,
      );
      process.exit(1);
    } else if (stage.sentinel) {
      attachmentsNote =
        `\n⚠️  Could not stage this goal's attachments — wrote .tasks/attachments/${stage.goalId}/.UNREADABLE.\n` +
        `   Check PM_DAEMON_TOKEN / connectivity, then re-run engine:goal-files -- --download to retry.\n`;
    }
  } catch (err) {
    // stageGoalAttachments is best-effort and shouldn't throw; guard anyway so a
    // surprise never breaks the (already-completed) claim.
    attachmentsNote = `\n⚠️  Could not stage goal attachments: ${err instanceof Error ? err.message : String(err)}\n`;
  }

  const n = data.task.displayNumber != null ? `#${data.task.displayNumber} ` : "";
  const startHere = destDir === cwd ? "start `claude` here" : `cd into the worktree (above) and start \`claude\``;
  // When a worktree was made, tell the dev how to tear it down later — from the
  // PRIMARY clone (git won't remove the worktree you're standing in). engine:finish
  // auto-derives the path, so just the task ref is needed (#447).
  const teardownHint =
    destDir !== cwd
      ? `\nWhen done (goal merged), tear down FROM THE PRIMARY CLONE: \`npm run engine:finish -- ${
          data.task.displayNumber != null ? `#${data.task.displayNumber}` : data.task.id
        }\`\n`
      : "";
  process.stdout.write(
    `[engine-work] Working ${n}${data.task.title} (${data.task.phase}) — run ${data.run.id} [interactive].\n` +
      worktreeNote +
      attachmentsNote +
      `\nNext: ${startHere}. The PM bridge will register a session and link it to the run.\n` +
      `Submit the deliverable with pm_submit_artifact; report done with \`npm run engine:report\`.\n` +
      teardownHint +
      renderPhaseJobBlock(data.phaseJob),
  );
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-work.ts"))) {
  void run();
}
