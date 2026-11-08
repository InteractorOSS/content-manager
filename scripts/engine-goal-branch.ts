// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

// S3 (PR-state source-of-truth redesign): the ONE canonical derivation of a prBoundary
// goal's integration-branch name. Kept dependency-free (no db / prisma) ON PURPOSE so it
// is the single source of truth shared by BOTH the server (resolveTaskIntegration — what
// the daemon checks out + the phase job tells the agent) AND the `engine:work` CLI
// (scripts/engine-worktree.ts `deriveBranchName` — what the worktree/PR branch is). Before
// S3 those two derivations diverged for slug-less goals (server: `goal/<full-uuid>`, CLI:
// `goal/<id-first-8>`); collapsing them here removes that split at the source.

/** kebab a slug for use in a git branch ref — lowercase, non-alphanumerics→`-`, trimmed,
 *  capped. Matches the historical `engine:work` kebab so existing branches keep resolving. */
export function kebabSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * The canonical integration-branch name for a prBoundary goal — the branch its single PR
 * lives on. A `slug` → `goal/<kebab-slug>`, otherwise the short id → `goal/<id-first-8>`.
 * A pure function of the goal, so the branch never needs to be stored to be known.
 */
export function deriveGoalBranch(goal: { slug: string | null; id: string }): string {
  return goal.slug ? `goal/${kebabSlug(goal.slug)}` : `goal/${goal.id.slice(0, 8)}`;
}

/**
 * Ordered, de-duplicated branch candidates to look an out-of-band goal PR up by when the
 * goal recorded none. The FIRST entry is the canonical {@link deriveGoalBranch} name; the
 * rest cover the historical naming split (raw slug / full uuid) so a PR opened by an older
 * code path — or before S3 — still resolves. As pre-S3 goals age out this can shrink to
 * just the canonical name.
 */
export function goalBranchCandidates(goal: { slug: string | null; id: string }): string[] {
  const out: string[] = [];
  if (goal.slug) {
    out.push(`goal/${kebabSlug(goal.slug)}`);
    out.push(`goal/${goal.slug}`);
  }
  out.push(`goal/${goal.id.slice(0, 8)}`);
  out.push(`goal/${goal.id}`);
  return [...new Set(out)];
}
