#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local engine-task finish / teardown vehicle (cutover C2c).
 *
 * The engine analog of the legacy `/i/task-finish`: confirm a task has reached a
 * terminal state (done / cancelled) and tidy up the local loop context. Unlike
 * the legacy command it does NOT close a GitHub issue — the engine has no
 * per-task issue (the GOAL owns the branch + PR; `engine:goal accept` is the
 * deliver/merge step).
 *
 * What it does:
 *   1. Determine the task — from a passed identifier, else from `.tasks/.engine`.
 *   2. Assert the task is terminal (done / cancelled); else refuse and point at
 *      `engine:report` (which drives a still-open task forward).
 *   3. Clear `.tasks/.engine` + `.tasks/.current` (best-effort) so the loop is clean.
 *   4. Remove the task's git worktree. Since `engine:work` now auto-creates a
 *      per-goal worktree at a DETERMINISTIC path (#440), this AUTO-DERIVES that
 *      path (the same fetchBranchSource → deriveBranchName → worktreePathFor the
 *      creation uses) and removes it if present — no `--worktree` needed. An
 *      explicit `--worktree <path>` overrides the derived path; and passed ALONE
 *      (no task) it just removes that worktree (for a hand-made one).
 *
 * Run from the PRIMARY clone: git refuses to remove the worktree you're standing
 * in, and the interactive session lives inside the worktree (#440).
 *
 * Usage:
 *   npm run engine:finish                       # task from .tasks/.engine; auto-removes its worktree
 *   npm run engine:finish -- <#N | slug | title>  # auto-removes that task's worktree
 *   npm run engine:finish -- <#N> --worktree <path>   # override the derived path
 *   npm run engine:finish -- --worktree <path>        # standalone: just remove a worktree
 */

import * as fs from "fs";
import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { TERMINAL_STATES } from "./engine-config";
import { resolveTask, summaryLine, fetchBranchSource } from "./engine-work";
import { parseEngineContext } from "./engine-report";
import { fetchTask } from "./engine-status";
import { deriveBranchName, gitDirs, removeWorktree, worktreeExists, worktreePathFor } from "./engine-worktree";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

// TERMINAL_STATES and removeWorktree moved to engine-config.ts / engine-worktree.ts
// (goal fe6d12af) so engine-reap.ts can use them without importing this file — this
// file imports engine-work.ts, and engine-work.ts now imports engine-reap.ts as a
// preflight, which would otherwise cycle back here. Re-exported below for anything
// still importing `TERMINAL_STATES`/`removeWorktree` from "./engine-finish".
export { TERMINAL_STATES, removeWorktree };

export interface FinishArgs {
  identifier?: string;
  worktreePath?: string;
}

export type FinishParse = { ok: true; args: FinishArgs } | { ok: false; error: string };

const USAGE =
  "Usage: npm run engine:finish -- [<#N | slug | title>] [--worktree <path>]";

/** Parse the optional identifier (first non-flag) + `--worktree <path>`. */
export function parseFinishArgs(argv: string[]): FinishParse {
  let identifier: string | undefined;
  let worktreePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--worktree") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing path for --worktree\n${USAGE}` };
      worktreePath = val;
      continue;
    }
    if (tok.startsWith("--")) return { ok: false, error: `Unknown flag ${tok}\n${USAGE}` };
    if (identifier === undefined && tok !== "") {
      identifier = tok;
      continue;
    }
    return { ok: false, error: `Unexpected argument "${tok}"\n${USAGE}` };
  }
  return { ok: true, args: { identifier, worktreePath } };
}

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** Summary line for a successful finish. */
export function formatFinish(
  taskTitle: string,
  state: string,
  cleared: string[],
  removedWorktree?: string,
): string {
  const lines = [`[engine-finish] "${taskTitle}" is ${state} — local loop tidied.`];
  lines.push(cleared.length ? `  cleared: ${cleared.join(", ")}` : "  cleared: nothing (already clean)");
  if (removedWorktree) lines.push(`  removed worktree: ${removedWorktree}`);
  return lines.join("\n") + "\n";
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

/**
 * The task's worktree path, derived the SAME way `engine:work` created it (#440),
 * or null if it isn't a checked-out worktree right now. Computed against the
 * PRIMARY clone's toplevel (dirname of the common git-dir) so it's correct even
 * when invoked from inside a worktree.
 */
async function deriveTaskWorktree(
  cfg: SyncConfig | null,
  token: string,
  taskId: string,
  primaryToplevel: string,
): Promise<string | null> {
  if (!cfg) return null;
  const src = await fetchBranchSource(fetch, cfg, token, taskId);
  const candidate = worktreePathFor(primaryToplevel, deriveBranchName(src));
  return worktreeExists(primaryToplevel, candidate) ? candidate : null;
}

/** The primary clone's toplevel — dirname of the common git-dir, correct from
 *  either the primary clone or a linked worktree. */
function primaryToplevelOf(cwd: string): string {
  return path.dirname(gitDirs(cwd).gitCommonDir);
}

async function run(): Promise<void> {
  const cwd = process.cwd();

  const parsedArgs = parseFinishArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    process.stderr.write(`[engine-finish] ${parsedArgs.error}\n`);
    process.exit(1);
  }
  const args = parsedArgs.args;

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-finish] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-finish] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const enginePath = path.join(cwd, ".tasks", ".engine");
  const currentPath = path.join(cwd, ".tasks", ".current");

  // Resolve the taskId: from the identifier, else from .tasks/.engine. May be
  // absent — that's allowed when --worktree is passed (standalone teardown).
  let taskId: string | undefined;
  try {
    if (args.identifier) {
      const resolution = await resolveTask(fetch, cfg, token, args.identifier);
      if (resolution.kind === "ambiguous") {
        process.stderr.write(`[engine-finish] "${args.identifier}" matches multiple tasks — be more specific:\n`);
        resolution.matches.forEach((m) => process.stderr.write(summaryLine(m) + "\n"));
        process.exit(1);
      }
      if (resolution.kind === "not_found") {
        process.stderr.write(`[engine-finish] No engine task matches "${args.identifier}".\n`);
        process.exit(1);
      }
      taskId = resolution.task.id;
    } else if (fs.existsSync(enginePath)) {
      const ctx = parseEngineContext(fs.readFileSync(enginePath, "utf8"));
      if (!ctx) {
        process.stderr.write("[engine-finish] .tasks/.engine is malformed — pass a task identifier instead.\n");
        process.exit(1);
      }
      taskId = ctx.taskId;
    }

    // Standalone teardown (Option A): no task to anchor to, but a worktree path was
    // given — just remove it. No terminal-state check (there's no task to check).
    if (!taskId) {
      if (args.worktreePath) {
        const err = removeWorktree(args.worktreePath);
        if (err) {
          process.stderr.write(`[engine-finish] Failed to remove worktree ${args.worktreePath}: ${err}\n`);
          process.exit(1);
        }
        process.stdout.write(`[engine-finish] Removed worktree: ${args.worktreePath}\n`);
        return;
      }
      process.stderr.write(
        "[engine-finish] No task identifier and no .tasks/.engine — pass <#N | slug | title> or --worktree <path>.\n",
      );
      process.exit(1);
    }

    // Assert terminal — refuse to tidy up an in-flight task.
    const { task } = await fetchTask(fetch, cfg, token, taskId);
    if (!isTerminalState(task.runtimeState)) {
      process.stderr.write(
        `[engine-finish] Task "${task.title}" is ${task.runtimeState}, not terminal. ` +
          `Run \`npm run engine:report\` to drive it forward first.\n`,
      );
      process.exit(1);
    }

    // Clear local loop context (best-effort).
    const cleared: string[] = [];
    for (const [p, label] of [
      [enginePath, ".tasks/.engine"],
      [currentPath, ".tasks/.current"],
    ] as const) {
      if (fs.existsSync(p)) {
        fs.rmSync(p);
        cleared.push(label);
      }
    }

    // Remove the task's worktree. An explicit --worktree overrides; otherwise
    // AUTO-DERIVE the path the same way engine:work created it (#440) and remove
    // it only if it's currently a checked-out worktree.
    let removedWorktree: string | undefined;
    // Compute the primary toplevel once: it's both where we derive the worktree
    // path against AND the repo cwd we run `git worktree remove` from, so removal
    // is as cwd-robust as the derive (correct even if invoked from a worktree).
    const primaryToplevel = primaryToplevelOf(cwd);
    let worktreeTarget = args.worktreePath;
    if (!worktreeTarget) {
      try {
        worktreeTarget = (await deriveTaskWorktree(cfg, token, taskId, primaryToplevel)) ?? undefined;
      } catch {
        // Best-effort: a derive failure (e.g. API hiccup) shouldn't block tidying.
      }
    }
    if (worktreeTarget) {
      const err = removeWorktree(worktreeTarget, primaryToplevel);
      if (err) {
        process.stderr.write(
          `[engine-finish] Tidied context, but failed to remove worktree ${worktreeTarget}: ${err}\n` +
            `(Run engine:finish from the PRIMARY clone — git won't remove the worktree you're standing in.)\n`,
        );
        // Non-fatal: the loop context is already cleared; surface the failure.
      } else {
        removedWorktree = worktreeTarget;
      }
    }

    process.stdout.write(formatFinish(task.title, task.runtimeState, cleared, removedWorktree));
  } catch (err) {
    process.stderr.write(`[engine-finish] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-finish.ts"))) {
  void run();
}
