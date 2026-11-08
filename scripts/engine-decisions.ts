#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local engine design-decisions vehicle — a thin READ-ONLY CLI over the S1
 * decisions-as-data surface (concurrency redesign, shipped #1097).
 *
 * A goal's open design points become CANONICAL keyed `Decision` rows instead of
 * editable prose. This CLI lets a developer (or an interactive agent) running the
 * local engine loop SEE what's already locked on a goal before re-investigating
 * and forking a contradictory answer:
 *
 *   list <goalUuid>   GET /me/engine/goals/:goalId/decisions
 *                     → each ACTIVE row's designKey / title / status / recordedById
 *
 * READ-ONLY BY DESIGN. Recording a decision is SESSION-ONLY: the POST route 403s a
 * daemon token on purpose (a decision is a human lock; the fleet must never
 * merge-race one — that's the whole protection this slice exists for). This CLI
 * carries a daemon token, so it deliberately exposes NO `record` subcommand. Any
 * future write affordance must run under a user session, not this token.
 *
 * Goal #N/slug resolution is UUID-only today — pass the goal's UUID.
 *
 * Credential + config are shared with engine-claim/work/status: `.build/.sync` (or legacy `.tasks/.sync`) for
 * the base URL + project id, PM_DAEMON_TOKEN from the environment.
 *
 * Usage:
 *   npm run engine:decisions -- list <goalUuid>
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

/** One active keyed design-point decision, as returned by the GET route. */
export interface DesignDecision {
  id: string;
  designKey: string | null;
  title: string;
  status: string;
  recordedById: string | null;
}

export type ParsedArgs =
  | { kind: "list"; goalId: string }
  | { kind: "error"; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse argv (without node/script) into a subcommand. Pure — no I/O. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [command, goalId] = positional;
  if (command !== "list") {
    return { kind: "error", message: "Usage: npm run engine:decisions -- list <goalUuid>" };
  }
  if (!goalId) {
    return { kind: "error", message: "Missing <goalUuid>. Usage: npm run engine:decisions -- list <goalUuid>" };
  }
  if (!UUID_RE.test(goalId)) {
    return {
      kind: "error",
      message: `"${goalId}" is not a goal UUID. Goal #N/slug resolution isn't supported here yet — pass the goal's UUID.`,
    };
  }
  return { kind: "list", goalId };
}

/** Render the active design decisions for a goal. Pure — no I/O — so it's testable. */
export function formatDecisions(goalId: string, decisions: DesignDecision[]): string {
  const lines: string[] = [];
  lines.push(`[engine-decisions] goal ${goalId} — ${decisions.length} active design decision(s)`);
  if (decisions.length === 0) {
    lines.push("  (none locked yet)");
  } else {
    for (const d of decisions) {
      const key = d.designKey ?? "(no-key)";
      lines.push(`  ${key}  ${d.title}`);
      lines.push(`    status:     ${d.status}`);
      lines.push(`    recordedBy: ${d.recordedById ?? "(unknown)"}`);
    }
  }
  return lines.join("\n") + "\n";
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** GET /me/engine/goals/:goalId/decisions — active keyed decisions. Throws on non-OK. */
export async function fetchDecisions(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
): Promise<DesignDecision[]> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals/${goalId}/decisions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Decisions fetch failed: ${res.status}`);
  const body = (await res.json()) as { data?: { decisions?: DesignDecision[] } };
  return body.data?.decisions ?? [];
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "error") {
    process.stderr.write(`[engine-decisions] ${parsed.message}\n`);
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-decisions] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-decisions] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    const decisions = await fetchDecisions(fetch, cfg, token, parsed.goalId);
    process.stdout.write(formatDecisions(parsed.goalId, decisions));
  } catch (err) {
    process.stderr.write(`[engine-decisions] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-decisions.ts"))) {
  void run();
}
