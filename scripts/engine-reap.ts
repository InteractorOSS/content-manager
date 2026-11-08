#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local worktree/branch reaper (goal fe6d12af).
 *
 * `engine:finish` removes a task's worktree, but it's a manual step nobody
 * reliably runs — merged-goal worktrees and branches pile up on a developer's
 * (or the always-on scheduled loop's) machine indefinitely. This sweeps every
 * LINKED worktree of the primary clone, resolves the goal/task each one's
 * branch belongs to, and removes the ones whose owner has reached a terminal
 * state (accepted/cancelled, or done/cancelled for a goalless task) — but ONLY
 * when the worktree is clean and fully pushed. A worktree with uncommitted or
 * unpushed work is left alone and reported, never force-deleted: this reaper
 * must never destroy in-flight work, only clear away what's already shipped.
 *
 * Usage:
 *   npm run engine:reap             # standalone sweep, prints a summary
 *
 * Also called as a best-effort preflight from `engine:work` and `engine:claim`
 * (`reapBestEffort`) so both interactive and autonomous sessions self-heal on
 * every invocation without anyone remembering `engine:finish`.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { resolveSyncFile, loadDaemonToken, TERMINAL_STATES, type SyncConfig } from "./engine-config";
import { gitDirs, removeWorktree } from "./engine-worktree";

// NOTE: deliberately does NOT import from engine-work.ts / engine-claim.ts / engine-finish.ts
// — engine-work.ts and engine-claim.ts both call `reapBestEffort` as a preflight, and
// engine-finish.ts imports engine-work.ts, so importing back from here would create a
// module cycle. `resolveTaskState` below duplicates the small resolve-by-identifier
// call rather than reusing engine-work.ts's `resolveTask` for that reason.

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

/** Goal statuses from which a worktree is eligible for reaping (mirrors the server's
 *  GOAL_TERMINAL_STATUSES — duplicated locally rather than imported so this CLI script
 *  stays dependency-free of `@/lib/engine`'s db/prisma-touching modules, same reasoning
 *  as `deriveGoalBranch`'s split-out in engine-worktree.ts). */
export const GOAL_TERMINAL_STATUSES = new Set(["accepted", "cancelled"]);

export type BranchKind =
  | { kind: "goal"; identifier: string }
  | { kind: "task"; identifier: string }
  | { kind: "other" };

/** `goal/<slug-or-id8>` → goal-scoped; `task/<slug-or-id8>` → goalless-task-scoped; else other. */
export function classifyBranch(branch: string): BranchKind {
  if (branch.startsWith("goal/")) return { kind: "goal", identifier: branch.slice("goal/".length) };
  if (branch.startsWith("task/")) return { kind: "task", identifier: branch.slice("task/".length) };
  return { kind: "other" };
}

export type ReapDecision =
  | { action: "remove" }
  | { action: "skip"; reason: "dirty" | "unpushed" }
  | { action: "leave" };

/** The core policy, isolated for unit testing: never remove anything but a clean,
 *  fully-pushed worktree whose owner has reached a terminal state. */
export function decideReap(input: { terminal: boolean; clean: boolean; unpushedCount: number }): ReapDecision {
  if (!input.terminal) return { action: "leave" };
  if (!input.clean) return { action: "skip", reason: "dirty" };
  if (input.unpushedCount > 0) return { action: "skip", reason: "unpushed" };
  return { action: "remove" };
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** Parse `git worktree list --porcelain` into entries, in source order. */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "" && current?.path) {
      entries.push({ path: current.path, branch: current.branch ?? null });
      current = null;
    }
  }
  if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The primary clone's toplevel, correct whether invoked from the primary clone or
 *  a linked worktree (same derivation as engine-finish.ts's private helper). */
function primaryToplevelOf(cwd: string): string {
  return path.dirname(gitDirs(cwd).gitCommonDir);
}

/** Every LINKED worktree of the primary clone (excludes the primary clone itself and
 *  whichever worktree `cwd` currently is — git refuses to remove the one you're in). */
export function listReapCandidates(primaryToplevel: string, cwd: string): WorktreeEntry[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: primaryToplevel,
    encoding: "utf8",
  });
  const primary = canon(primaryToplevel);
  const current = canon(cwd);
  return parseWorktreePorcelain(out).filter((e) => {
    const c = canon(e.path);
    return c !== primary && c !== current;
  });
}

function isClean(wtPath: string): boolean {
  return execFileSync("git", ["status", "--porcelain"], { cwd: wtPath, encoding: "utf8" }).trim() === "";
}

/** Commits on the branch not yet on its upstream. No upstream configured is treated
 *  as "can't verify pushed" → a large sentinel so the branch is conservatively skipped
 *  rather than assumed safe to delete. */
function unpushedCount(wtPath: string): number {
  try {
    const out = execFileSync("git", ["rev-list", "--count", "@{u}..HEAD"], {
      cwd: wtPath,
      encoding: "utf8",
    }).trim();
    return Number(out) || 0;
  } catch {
    return 1;
  }
}

async function resolveGoalStatus(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  identifier: string,
): Promise<string | null> {
  const url =
    `${cfg.baseUrl}/api/v1/me/engine/goals/resolve` +
    `?projectId=${encodeURIComponent(cfg.projectId)}&identifier=${encodeURIComponent(identifier)}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Goal resolve failed: ${res.status}`);
  const body = (await res.json()) as { data: { kind: string; goal?: { status: string } } };
  if (body.data.kind !== "found") return null;
  return body.data.goal?.status ?? null;
}

/** GET /me/engine/resolve — same endpoint engine-work.ts's `resolveTask` uses, called
 *  directly here (rather than imported) to avoid a module cycle — see the note above. */
async function resolveTaskState(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  identifier: string,
): Promise<string | null> {
  const url =
    `${cfg.baseUrl}/api/v1/me/engine/resolve` +
    `?projectId=${encodeURIComponent(cfg.projectId)}&identifier=${encodeURIComponent(identifier)}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Task resolve failed: ${res.status}`);
  const body = (await res.json()) as { data: { kind: string; task?: { runtimeState: string } } };
  if (body.data.kind !== "found") return null;
  return body.data.task?.runtimeState ?? null;
}

function deleteLocalBranch(primaryToplevel: string, branch: string): void {
  try {
    execFileSync("git", ["branch", "-d", branch], { cwd: primaryToplevel, stdio: "pipe" });
  } catch {
    // The goal/task is confirmed terminal server-side even when the local branch isn't a
    // literal ancestor of main (e.g. squash-merged) — force-delete only after that check.
    try {
      execFileSync("git", ["branch", "-D", branch], { cwd: primaryToplevel, stdio: "pipe" });
    } catch {
      /* best-effort: an unremovable branch is cosmetic clutter, not worth failing the sweep over */
    }
  }
}

export interface ReapSummary {
  removed: string[];
  skipped: { path: string; reason: string }[];
  left: number;
  errors: { path: string; error: string }[];
}

/** Run the full sweep. Never throws for a single worktree's failure — each entry is
 *  isolated so one bad API call or git error doesn't abort the rest of the sweep. */
export async function reap(cwd: string = process.cwd(), fetchFn: FetchFn = fetch): Promise<ReapSummary> {
  const summary: ReapSummary = { removed: [], skipped: [], left: 0, errors: [] };
  const primaryToplevel = primaryToplevelOf(cwd);

  const resolved = resolveSyncFile(primaryToplevel);
  if (!resolved) return summary;
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch {
    return summary;
  }

  const entries = listReapCandidates(primaryToplevel, cwd);
  for (const entry of entries) {
    try {
      if (!entry.branch) continue; // detached HEAD — not an engine-managed worktree
      const classified = classifyBranch(entry.branch);

      let terminal: boolean;
      if (classified.kind === "goal") {
        const status = await resolveGoalStatus(fetchFn, cfg, token, classified.identifier);
        if (status == null) continue; // couldn't resolve — leave alone rather than guess
        terminal = GOAL_TERMINAL_STATUSES.has(status);
      } else if (classified.kind === "task") {
        const runtimeState = await resolveTaskState(fetchFn, cfg, token, classified.identifier);
        if (runtimeState == null) continue; // couldn't resolve — leave alone rather than guess
        terminal = TERMINAL_STATES.has(runtimeState);
      } else {
        continue; // not a goal/task branch this reaper owns
      }

      const clean = isClean(entry.path);
      const unpushed = unpushedCount(entry.path);
      const decision = decideReap({ terminal, clean, unpushedCount: unpushed });

      if (decision.action === "leave") {
        summary.left++;
        continue;
      }
      if (decision.action === "skip") {
        summary.skipped.push({ path: entry.path, reason: decision.reason });
        process.stdout.write(
          `[engine-reap] SKIP ${entry.path} — ${decision.reason}, not removed. ` +
            `Resolve manually, then re-run (or \`engine:finish -- --worktree ${entry.path}\`).\n`,
        );
        continue;
      }

      const err = removeWorktree(entry.path, primaryToplevel);
      if (err) {
        summary.errors.push({ path: entry.path, error: err });
        continue;
      }
      deleteLocalBranch(primaryToplevel, entry.branch);
      summary.removed.push(entry.path);
    } catch (e) {
      summary.errors.push({ path: entry.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}

/** Best-effort wrapper: swallows every error so a reap failure never blocks the
 *  command that triggered it (engine:work / engine:claim preflight). */
export async function reapBestEffort(cwd: string = process.cwd()): Promise<void> {
  try {
    const summary = await reap(cwd);
    if (summary.removed.length || summary.errors.length) {
      process.stdout.write(
        `[engine-reap] ${summary.removed.length} removed, ${summary.skipped.length} skipped, ` +
          `${summary.errors.length} errors\n`,
      );
    }
  } catch {
    /* never let a reap failure block the parent command */
  }
}

async function main(): Promise<void> {
  const summary = await reap();
  process.stdout.write(
    `[engine-reap] done — ${summary.removed.length} removed, ${summary.skipped.length} skipped, ` +
      `${summary.left} left (non-terminal), ${summary.errors.length} errors\n`,
  );
  for (const e of summary.errors) process.stderr.write(`[engine-reap] ERROR ${e.path}: ${e.error}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[engine-reap] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
