#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local "why isn't this being claimed?" vehicle — for every task under a goal, print the
 * structured claimability verdict (why a queued task is / isn't currently claimable). The
 * headless counterpart of the goal-detail diagnostic; turns the ~15-call investigation the
 * goal 9c54000c incident needed into one command.
 *
 * Reads the goal's tasks with the explainer attached via the v2 route:
 *   GET /api/v2/projects/{projectId}/goals/{goalId}/tasks?explain=1
 * (authorizeProject accepts the daemon bearer, same as the other v2 goal reads.)
 *
 * Config + credential shared with the rest of the engine loop: `.build/.sync` (or legacy
 * `.tasks/.sync`) for the base URL + project id, PM_DAEMON_TOKEN from the environment.
 *
 * Usage:
 *   npm run engine:why -- <goalId>
 */
import { resolveSyncFile, loadDaemonToken } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface ClaimReason {
  kind: string;
  detail: string;
}
export interface TaskClaimRow {
  displayNumber?: number | null;
  title?: string | null;
  type?: string | null;
  phase?: string | null;
  runtimeState?: string | null;
  claimability?: { claimable: boolean; reasons: ClaimReason[] } | null;
}

/** Render one task's claimability as a compact multi-line block. Pure → unit-tested. */
export function formatTaskClaim(t: TaskClaimRow): string {
  const num = t.displayNumber != null ? `#${t.displayNumber} ` : "";
  const head = `${num}${t.title ?? "(untitled)"}  [${t.type ?? "?"}/${t.phase ?? "?"}/${t.runtimeState ?? "?"}]`;
  const c = t.claimability;
  if (!c) return `${head}\n    (no claimability verdict)`;
  if (c.claimable) return `${head}\n    ✅ claimable — a healthy fleet should pick it up`;
  const lines = c.reasons.map((r) => `    ⛔ ${r.kind}: ${r.detail}`);
  return [`${head}  ⛔ NOT claimable`, ...lines].join("\n");
}

/** Whole-report render — header + each task, newest not sorted (server order preserved). */
export function formatReport(goalId: string, tasks: TaskClaimRow[]): string {
  if (tasks.length === 0) return `Goal ${goalId}: no tasks.`;
  return [`Goal ${goalId} — ${tasks.length} task(s):`, "", ...tasks.map((t) => formatTaskClaim(t) + "\n")].join("\n");
}

// ─── I/O shell ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const goalId = process.argv[2];
  if (!goalId) {
    process.stderr.write("Usage: npm run engine:why -- <goalId>\n");
    process.exit(1);
  }
  const resolved = resolveSyncFile(process.cwd());
  if (!resolved) {
    process.stderr.write(
      "[engine-why] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
    return;
  }
  const cfg = resolved.cfg;
  const token = loadDaemonToken(process.env);
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/goals/${goalId}/tasks?explain=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    process.stderr.write(`[engine-why] ${res.status} ${res.statusText} for ${url}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as { data?: TaskClaimRow[] };
  process.stdout.write(formatReport(goalId, body.data ?? []) + "\n");
}

// Only run when invoked directly (keeps the pure exports importable by the test).
if (process.argv[1] && process.argv[1].endsWith("engine-why.ts")) {
  main().catch((e) => {
    process.stderr.write(`[engine-why] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
