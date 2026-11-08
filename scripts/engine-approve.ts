#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local spec-approval gate vehicle (cutover C2c).
 *
 * The engine analog of the legacy `/i/task-spec` human approval moment: when a
 * task's investigation completes and the project opts into spec approval
 * (`Project.requireSpecApproval`, cutover C2a), the engine raises a
 * `spec_approval` pause. This resolves it from the terminal — `resume` advances
 * investigation → execution; `--reject "reason"` cancels the task instead.
 *
 * Flow: resolve the identifier (GET /me/engine/resolve) → find the task's open
 * `spec_approval` pause (GET /me/engine/pauses?taskId=) → resolve it
 * (POST /me/engine/pauses/:id/resolve). Refuses cleanly when there's no open
 * spec_approval pause (nothing to approve).
 *
 * Credential + config are shared with engine-claim/work/report.
 *
 * Usage:
 *   npm run engine:approve -- <#N | slug | title-fragment>
 *   npm run engine:approve -- <#N | slug | title-fragment> --reject "reason"
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { resolveTask, summaryLine } from "./engine-work";
import { fetchTaskPauses } from "./engine-status";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

/** The pause kind the spec-approval gate raises (cutover C2a). */
export const SPEC_APPROVAL_KIND = "spec_approval";

export interface ApprovePause {
  id: string;
  kind: string;
  reason: string | null;
}

export interface ApproveArgs {
  identifier: string;
  reject: boolean;
  reason?: string;
}

export type ApproveParse = { ok: true; args: ApproveArgs } | { ok: false; error: string };

const USAGE =
  'Usage: npm run engine:approve -- <#N | slug | title-fragment> [--reject "reason"]';

/** Parse: first non-flag token is the identifier; `--reject [reason]` cancels. */
export function parseApproveArgs(argv: string[]): ApproveParse {
  let identifier: string | undefined;
  let reject = false;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--reject") {
      reject = true;
      // An optional reason follows --reject if the next token isn't another flag.
      if (argv[i + 1] != null && !argv[i + 1].startsWith("--")) reason = argv[++i];
      continue;
    }
    if (tok.startsWith("--")) return { ok: false, error: `Unknown flag ${tok}\n${USAGE}` };
    if (identifier === undefined && tok !== "") {
      identifier = tok;
      continue;
    }
    return { ok: false, error: `Unexpected argument "${tok}"\n${USAGE}` };
  }
  if (!identifier) return { ok: false, error: `A task identifier is required.\n${USAGE}` };
  return { ok: true, args: { identifier, reject, reason } };
}

/** Find the single open `spec_approval` pause among a task's pauses, if any. */
export function pickSpecApprovalPause(pauses: ApprovePause[]): ApprovePause | null {
  return pauses.find((p) => p.kind === SPEC_APPROVAL_KIND) ?? null;
}

/** The resolution to send for an approve vs a reject. */
export function approveResolution(reject: boolean): "resume" | "cancel" {
  return reject ? "cancel" : "resume";
}

/** Human-readable result line for a resolved spec-approval pause. */
export function formatApproveResult(args: ApproveArgs, pauseId: string): string {
  if (args.reject) {
    const why = args.reason ? ` — ${args.reason}` : "";
    return `[engine-approve] Rejected spec for "${args.identifier}" — task cancelled${why} (pause ${pauseId}).\n`;
  }
  return `[engine-approve] Approved spec for "${args.identifier}" — advancing to execution (pause ${pauseId}).\n`;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// Open-pauses read is shared with engine-status (`fetchTaskPauses`) — one source
// of truth for that GET; `ApprovePause` is the structural subset this CLI needs.

/** POST /me/engine/pauses/:id/resolve — throws with the server message on non-OK. */
export async function resolvePauseRemote(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  pauseId: string,
  resolution: "resume" | "cancel",
): Promise<void> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/pauses/${pauseId}/resolve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
  if (!res.ok) {
    let msg = `Resolve failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cwd = process.cwd();

  const parsedArgs = parseApproveArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    process.stderr.write(`[engine-approve] ${parsedArgs.error}\n`);
    process.exit(1);
  }
  const args = parsedArgs.args;

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-approve] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-approve] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    const resolution = await resolveTask(fetch, cfg, token, args.identifier);
    if (resolution.kind === "ambiguous") {
      process.stderr.write(`[engine-approve] "${args.identifier}" matches multiple tasks — be more specific:\n`);
      resolution.matches.forEach((m) => process.stderr.write(summaryLine(m) + "\n"));
      process.exit(1);
    }
    if (resolution.kind === "not_found") {
      process.stderr.write(`[engine-approve] No engine task matches "${args.identifier}".\n`);
      process.exit(1);
    }

    const pauses = await fetchTaskPauses(fetch, cfg, token, resolution.task.id);
    const pause = pickSpecApprovalPause(pauses);
    if (!pause) {
      process.stderr.write(
        `[engine-approve] No open spec_approval pause on "${args.identifier}". ` +
          `Nothing to approve (the task may not be at the spec gate, or approval is not required for this project).\n`,
      );
      process.exit(1);
    }

    await resolvePauseRemote(fetch, cfg, token, pause.id, approveResolution(args.reject));
    process.stdout.write(formatApproveResult(args, pause.id));
  } catch (err) {
    process.stderr.write(`[engine-approve] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-approve.ts"))) {
  void run();
}
