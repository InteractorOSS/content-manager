// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Worktree isolation for interactive `engine:work` (#440).
 *
 * The legacy `/i/task-open` ALWAYS created a git worktree (its step 3), so a task
 * could never tangle with the shared clone. The engine's `engine:work` dropped
 * that — it wrote run-context into whatever cwd you were in (the primary clone) —
 * which let concurrent git ops in one clone clobber a branch/PR (the 2026-06-09
 * PR #1041 collision). This module restores mandatory isolation:
 *
 *   - `gitDirs`/`isLinkedWorktree`: detect whether cwd is the PRIMARY clone or a
 *     linked worktree (in a linked worktree `git rev-parse --git-dir` ≠
 *     `--git-common-dir`).
 *   - `deriveBranchName`: a per-GOAL branch (`goal/<slug>`) so a goal's tasks
 *     share one worktree/branch/PR (one-PR-per-goal); falls back to a per-task
 *     branch for a goalless task.
 *   - `worktreePathFor`: the sibling worktree directory for a branch.
 *   - `ensureWorktree` / `seedWorktree`: create-or-reuse the worktree and
 *     lightweight-seed it (the gitignored `.build/.sync` / legacy `.tasks/.sync` +
 *     `.env.local`, a shared node_modules, `prisma generate`) so it isn't "blind"
 *     to the engine CLIs.
 *
 * The pure helpers are unit-tested; the I/O ones shell out to git/npx.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
// S3: the canonical goal-branch derivation, shared with the server (resolveTaskIntegration)
// so the worktree/PR branch this CLI creates is byte-identical to the one the daemon resolves.
// `goal-branch` is dependency-free, so importing it here pulls no db/prisma into the CLI.
// Vendored locally from product-manager's src/lib/engine/goal-branch.ts (no @/ alias here).
import { deriveGoalBranch } from "./engine-goal-branch";

/** Task detail (subset) used to name the worktree branch. */
export interface BranchSource {
  id: string;
  slug?: string | null;
  goalId?: string | null;
  goal?: { slug?: string | null } | null;
}

/** Run a git/CLI command and return trimmed stdout. Throws on non-zero exit. */
function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

/**
 * The current clone's git-dir and common-git-dir, both absolute. In the PRIMARY
 * clone they are the same `.git`; in a LINKED worktree the git-dir is
 * `<main>/.git/worktrees/<name>` while the common-dir is `<main>/.git`.
 */
export function gitDirs(cwd: string): { gitDir: string; gitCommonDir: string } {
  const gitDir = sh("git", ["rev-parse", "--git-dir"], cwd);
  const gitCommonDir = sh("git", ["rev-parse", "--git-common-dir"], cwd);
  // Both may be returned relative to cwd; resolve so the comparison is reliable.
  return { gitDir: path.resolve(cwd, gitDir), gitCommonDir: path.resolve(cwd, gitCommonDir) };
}

/** True when cwd is a linked worktree (git-dir differs from the common-dir). */
export function isLinkedWorktree(gitDir: string, gitCommonDir: string): boolean {
  return path.resolve(gitDir) !== path.resolve(gitCommonDir);
}

/** Kebab-safe segment for a branch slug — collapse anything unfriendly to a path. */
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * The branch a task's worktree lives on. PER GOAL (one-PR-per-goal): a goal with
 * a slug → `goal/<slug>`; a goal without a slug → `goal/<goalId8>`; a goalless
 * task → `task/<task-slug>` (or `task/<taskId8>` if it has no slug).
 */
export function deriveBranchName(src: BranchSource): string {
  // PER GOAL: the canonical goal branch via the SHARED derivation, so this matches exactly
  // what the server's resolveTaskIntegration resolves (no more slug-less full-uuid vs id8
  // split). `deriveGoalBranch` uses the slug when present (id ignored), else the short id.
  if (src.goal?.slug || src.goalId) return deriveGoalBranch({ slug: src.goal?.slug ?? null, id: src.goalId ?? "" });
  // Goalless task → its own branch.
  if (src.slug) return `task/${kebab(src.slug)}`;
  return `task/${src.id.slice(0, 8)}`;
}

/**
 * The sibling worktree directory for a branch: `<parent>/<repo>-<branch-slug>`.
 * `primaryToplevel` is the primary clone's `git rev-parse --show-toplevel`.
 */
export function worktreePathFor(primaryToplevel: string, branch: string): string {
  const base = path.basename(primaryToplevel);
  const slug = branch.replace(/\//g, "-");
  return path.join(path.dirname(primaryToplevel), `${base}-${slug}`);
}

/**
 * Canonical absolute path: resolve symlinks when the path exists (git reports
 * realpaths — e.g. macOS /var → /private/var — so a plain path.resolve would miss
 * a match), else fall back to a lexical resolve for a not-yet-created path.
 */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Does a git worktree already exist at `wtPath`? (parses `git worktree list --porcelain`). */
export function worktreeExists(primaryToplevel: string, wtPath: string): boolean {
  const out = sh("git", ["worktree", "list", "--porcelain"], primaryToplevel);
  const target = canon(wtPath);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => canon(l.slice("worktree ".length)) === target);
}

/**
 * Remove a git worktree (force, non-interactive). `cwd` must be a working tree of
 * the owning repo (the primary clone, per the run-from-primary rule — git won't
 * remove the worktree you're standing in). Returns null on success, else the
 * error detail. Moved here from engine-finish.ts (goal fe6d12af) so engine-reap.ts
 * can use it without importing engine-finish.ts (which imports engine-work.ts,
 * which imports engine-reap.ts — a cycle).
 */
export function removeWorktree(worktreePath: string, cwd: string = process.cwd()): string | null {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd, stdio: "pipe" });
    return null;
  } catch (e) {
    const detail = e instanceof Error && "stderr" in e ? String((e as { stderr?: Buffer }).stderr ?? "") : "";
    return detail.trim() || (e instanceof Error ? e.message : String(e));
  }
}

/** True if a branch ref exists locally or on origin. */
function branchExists(primaryToplevel: string, branch: string): boolean {
  try {
    sh("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], primaryToplevel);
    return true;
  } catch {
    /* not local */
  }
  try {
    sh("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], primaryToplevel);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the worktree if absent, reuse it if present. A brand-new branch is cut
 * from a freshly-fetched `origin/main`; an existing branch (e.g. a goal branch a
 * sibling task already opened) is checked out into the new worktree. Returns
 * whether it was newly created.
 */
export function ensureWorktree(primaryToplevel: string, branch: string, wtPath: string): { created: boolean } {
  if (worktreeExists(primaryToplevel, wtPath)) return { created: false };
  if (branchExists(primaryToplevel, branch)) {
    sh("git", ["worktree", "add", wtPath, branch], primaryToplevel);
  } else {
    sh("git", ["fetch", "origin", "main", "--quiet"], primaryToplevel);
    sh("git", ["worktree", "add", "-b", branch, wtPath, "origin/main"], primaryToplevel);
  }
  return { created: true };
}

/**
 * Lightweight seed: make the worktree usable by the engine CLIs without a full
 * `npm ci`. Copies whichever gitignored sync file(s) exist in the primary clone —
 * `.build/.sync` (canonical) and/or the legacy `.tasks/.sync` — plus `.env.local`
 * (without them the worktree is blind — no sync config / daemon token), shares
 * node_modules (hardlink-copy, falling back to a symlink), and runs `prisma
 * generate`. Each step is best-effort + idempotent.
 */
export function seedWorktree(primaryToplevel: string, wtPath: string): void {
  // Gitignored config the worktree can't get from the tree. Copies whichever sync
  // file(s) actually exist in the primary clone — `.build/.sync` (canonical) and/or
  // the legacy `.tasks/.sync` — so the worktree matches the source repo either way.
  for (const rel of [path.join(".build", ".sync"), path.join(".tasks", ".sync"), ".env.local"]) {
    const src = path.join(primaryToplevel, rel);
    const dest = path.join(wtPath, rel);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  // Share node_modules rather than reinstall (assumes a compatible host). Turbopack
  // rejects a symlinked node_modules ("points out of the filesystem root"), so
  // hardlink-copy it (same filesystem → seconds, no reinstall) and only fall back to
  // a symlink when the hardlink can't be made (e.g. EXDEV, worktree on another disk).
  const nm = path.join(wtPath, "node_modules");
  const srcNm = path.join(primaryToplevel, "node_modules");
  // seedWorktree runs on every `engine:work`, not just at worktree creation, so a
  // hardlink-copy (an ordinary directory, indistinguishable from a real install by
  // lstat) needs its own marker to stay recognized as "shared" on later calls. Lives
  // inside node_modules itself so it's covered by the existing node_modules/ gitignore.
  const sharedMarker = path.join(nm, ".pm-worktree-shared");
  let sharesNodeModules = fs.existsSync(nm) && (fs.lstatSync(nm).isSymbolicLink() || fs.existsSync(sharedMarker));
  if (!fs.existsSync(nm) && fs.existsSync(srcNm)) {
    try {
      execFileSync("cp", ["-al", srcNm, nm]);
      fs.writeFileSync(sharedMarker, "");
      sharesNodeModules = true;
    } catch {
      try {
        fs.symlinkSync(srcNm, nm, "dir");
        sharesNodeModules = true;
      } catch {
        /* a pre-existing/racing link is fine */
      }
    }
  }
  // Only (re)generate the Prisma client when node_modules is a REAL install. A
  // shared node_modules (symlink or hardlink-copy) carries the primary clone's
  // already-generated client (same schema), so regenerating is redundant — and
  // worse, it would write into the SHARED node_modules/.prisma, racing any
  // concurrent engine:work. Skip it then.
  if (!sharesNodeModules && fs.existsSync(path.join(wtPath, "prisma", "schema.prisma"))) {
    try {
      execFileSync("npx", ["prisma", "generate"], { cwd: wtPath, stdio: "ignore" });
    } catch {
      /* non-fatal: the dev can run it by hand */
    }
  }
}
