#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fleet-queue viewer (engine:fleet) — shows the operator a trustworthy view of
 * what the fleet will claim next, in the exact order it will happen.
 *
 * The goals come from GET /api/v1/me/engine/fleet-queue, which is backed by the
 * same `orderedFleetCandidates` the claim path uses — so the order here can
 * never drift from what actually gets claimed.
 *
 * Usage:
 *   npm run engine:fleet
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface FleetGoalRow {
  goalId: string;
  displayNumber: number | null;
  title: string;
  priority: string;
  status: "running" | "waiting_on_you" | "queued";
  project: { name: string; slug: string; orgSlug: string };
  ownership: "mine" | "shared" | "other";
  ownerName: string | null;
  progress: { done: number; total: number };
  phase: string | null;
  currentTask: { taskId: string; displayNumber: number | null; title: string; machineId: string | null } | null;
}

/** Render the fleet queue to a human-readable string. Pure — no I/O. */
export function renderFleetQueue(goals: FleetGoalRow[]): string {
  if (goals.length === 0) {
    return "[engine-fleet] Queue is empty — no queued or active goals.\n";
  }

  const lines: string[] = [`[engine-fleet] ${goals.length} item(s):\n`];
  let queueRank = 0;

  for (const g of goals) {
    const num = g.displayNumber != null ? `#${g.displayNumber} ` : "";
    const phase = g.phase ? ` (${g.phase})` : "";
    const own =
      g.ownership === "other" ? `other (${g.ownerName ?? "?"})` : g.ownership;
    const proj = `${g.project.orgSlug}/${g.project.slug}`;

    let tag: string;
    let extra = "";
    if (g.status === "running") {
      tag = "[running]";
      if (g.currentTask?.machineId) extra = `  machine: ${g.currentTask.machineId}`;
    } else if (g.status === "waiting_on_you") {
      tag = "[waiting]";
    } else {
      queueRank += 1;
      tag = `[queue:${queueRank}]`;
    }

    const progress =
      g.progress.total > 0
        ? `  ${g.progress.done}/${g.progress.total} tasks`
        : "";

    lines.push(
      `  ${tag} ${num}${g.title}${phase}${extra}  ${own} · ${proj}${progress}`,
    );
  }

  lines.push(
    "\nMachines: npm run engine:status -- <#N>   Priority: npm run engine:priority",
  );
  return lines.join("\n") + "\n";
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchFleetQueue(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
): Promise<FleetGoalRow[]> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/fleet-queue`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fleet-queue fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: { goals: FleetGoalRow[] } };
  return body.data?.goals ?? [];
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-fleet] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-fleet] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    const goals = await fetchFleetQueue(fetch, cfg, token);
    process.stdout.write(renderFleetQueue(goals));
  } catch (err) {
    process.stderr.write(`[engine-fleet] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-fleet-queue.ts"))) {
  void run();
}
