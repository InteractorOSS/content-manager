#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local engine-GOAL creation vehicle (headless counterpart of the web "New goal").
 *
 * Creates an EngineGoal in the current project via the daemon-token endpoint
 * (`POST /api/v1/me/engine/goals`), using the same account-level PM_DAEMON_TOKEN
 * the rest of the local engine loop uses. This is an INTERACTIVE create, so it
 * sends `autoAdmit: true` by default — on an AUTO project the goal is admitted at
 * birth and its scoping `planning` task spawns immediately for an idle fleet to
 * claim, kicking off the whole autopilot loop. Pass `--dormant` (alias `--no-admit`)
 * to omit the hint so the goal is created dormant (TASK-LESS), to be scoped later.
 *
 * Config + credential are shared with engine-create/claim: `.build/.sync` (or legacy `.tasks/.sync`) for the
 * base URL + project id, PM_DAEMON_TOKEN from the environment.
 *
 * Usage:
 *   npm run engine:goal-create -- "<title>"
 *   npm run engine:goal-create -- "<title>" --desc "longer context"
 *   npm run engine:goal-create -- "<title>" --dormant            # create dormant, no scoping task
 *   npm run engine:goal-create -- "<title>" --owner <userId> --run  # admit on the owner's behalf,
 *                                                                     # running on THEIR fleet (any mode)
 *   npm run engine:goal-create -- "<title>" --blocked-by <goalUuid>  # create then mark blocked
 *   npm run engine:goal-create -- "<title>" --repos owner/repo,<connId>  # target these connected
 *                                                                        # github repos (multi-repo)
 *
 * `--repos <owner/repo,… | connId,…>` (epic b2007584) targets the goal at one or more connected
 * github repos, given as a comma-separated mix of `owner/repo` full-names and/or connection UUIDs
 * (the server resolves both to connectionIds). Omit it for the default single-primary-repo goal.
 *
 * `--run` (alias `--admit-for-owner`) is the assign-&-run create option (G#406): paired with
 * `--owner U`, the goal is created ALREADY admitted on U's behalf and running on U's fleet —
 * its scoping planning task spawns attributed to U — on ANY project mode (auto OR manual).
 * This differs from the default `autoAdmit`, which admits under the CREATOR and only on an
 * `auto` project. `--run` requires `--owner`.
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { resolveGoalRef, goalLabel } from "./engine-goal";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface GoalCreateArgs {
  title: string;
  description?: string;
  parentGoalId?: string;
  ownerId?: string;
  /** Instant-autopilot opt-OUT: `false` (set by `--dormant`/`--no-admit`) omits the
   *  `autoAdmit` hint so the goal is created dormant. Unset ⇒ the interactive default,
   *  which sends `autoAdmit: true` (admit-at-birth on an AUTO project). */
  autoAdmit?: boolean;
  /** Assign-&-run at creation (G#406) opt-in, set by `--run` (alias `--admit-for-owner`):
   *  with `--owner U`, admit the goal on U's behalf at birth — created already admitted and
   *  running on U's fleet (its scoping task attributed to U), on ANY project mode. Distinct
   *  from `autoAdmit`, which admits under the CREATOR only on an auto project. Requires
   *  `--owner` (the server 422s a run flag with no concrete owner). */
  runOnAssign?: boolean;
  /** D-A3.5 opt-in: one PR per goal (an integration branch + a single goal PR all the
   *  goal's code tasks commit onto), instead of a PR per task. */
  prBoundary?: boolean;
  /** D-A3.5 opt-in: once the goal's PR is review-ready + its deploy gate passes, the
   *  server auto-merges it (→ prod). Pair with `--pr-boundary`. */
  autoDeliver?: boolean;
  /** Operator-set classification of the work: `feature` | `bug` | `chore` (server default
   *  `feature`). Passed through verbatim; the server validates the enum. */
  type?: string;
  /** Manual, user-set ordering priority: `low` | `medium` | `high` | `urgent` (server
   *  default `medium`). Passed through verbatim; the server validates the enum. */
  priority?: string;
  /** S2: a goal ref (G#<n>/#<n>/bare-<n>/slug/title-fragment/uuid) the NEWLY-CREATED goal
   *  should be BLOCKED BY — after creating the goal we add a `blocks` GOAL edge
   *  `<blocker> → <new goal>`, so the new goal can't run until the dependency goal is
   *  delivered. Resolved post-create via resolveGoalRef. Goal-grain analog of
   *  `engine:create --blocked-by`. */
  blockedBy?: string;
  /** Multi-repo (epic b2007584) opt-in, set by `--repos <owner/repo,… | connId,…>`: the
   *  connected github repos this goal targets, as a mix of `owner/repo` full-names and/or
   *  connection UUIDs. Forwarded verbatim under the v1 route's `repos` field, which resolves
   *  each token to a connectionId server-side. Omitted entirely when absent, preserving the
   *  single-primary-repo fallback. */
  repos?: string[];
}

export type ParseResult = { ok: true; args: GoalCreateArgs } | { ok: false; error: string };

const USAGE =
  'Usage: npm run engine:goal-create -- "<title>" [--desc <text>] ' +
  "[--parent <goalId>] [--owner <userId>] [--run] [--type <feature|bug|chore>] " +
  "[--priority <low|medium|high|urgent>] [--dormant] [--pr-boundary] [--auto-deliver] " +
  "[--blocked-by <goalUuid>] [--repos <owner/repo,… | connId,…>]";

const FLAG_KEYS: Record<string, keyof GoalCreateArgs> = {
  "--desc": "description",
  "--parent": "parentGoalId",
  "--owner": "ownerId",
  "--type": "type",
  "--priority": "priority",
  "--blocked-by": "blockedBy",
};

export function parseArgs(argv: string[]): ParseResult {
  const out: Partial<GoalCreateArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--dormant" || tok === "--no-admit") {
      out.autoAdmit = false;
      continue;
    }
    if (tok === "--run" || tok === "--admit-for-owner") {
      out.runOnAssign = true;
      continue;
    }
    if (tok === "--pr-boundary") {
      out.prBoundary = true;
      continue;
    }
    if (tok === "--auto-deliver") {
      out.autoDeliver = true;
      continue;
    }
    if (tok === "--repos") {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for ${tok}\n${USAGE}` };
      // Comma-separated mix of owner/repo full-names and/or connection UUIDs; the server
      // resolves both. Trim each token and drop empties so trailing commas / spaces are benign.
      out.repos = val.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      continue;
    }
    const key = FLAG_KEYS[tok];
    if (key) {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for ${tok}\n${USAGE}` };
      (out[key] as string) = val;
      continue;
    }
    if (tok.startsWith("--")) return { ok: false, error: `Unknown flag ${tok}\n${USAGE}` };
    if (out.title === undefined) {
      if (tok === "") return { ok: false, error: `A title is required.\n${USAGE}` };
      out.title = tok;
      continue;
    }
    return { ok: false, error: `Unexpected argument "${tok}"\n${USAGE}` };
  }
  if (!out.title) return { ok: false, error: `A title is required.\n${USAGE}` };
  // `--auto-deliver` IMPLIES `--pr-boundary`: auto-deliver only ever acts on a
  // prBoundary goal (the deploy gate throws on a non-boundary goal and the
  // auto-deliver query filters prBoundary:true), so a lone `--auto-deliver` would
  // create a goal that silently never delivers. Honor the obvious intent instead.
  const prBoundary = out.prBoundary || out.autoDeliver ? true : undefined;
  // `--run` is meaningless without an owner to run under — the server 422s a run flag with no
  // concrete owner. Fail fast here with a clear CLI message instead of a round-trip refusal.
  if (out.runOnAssign && !out.ownerId) {
    return { ok: false, error: `--run requires --owner <userId> (a goal can't be run on nobody's fleet)\n${USAGE}` };
  }
  return { ok: true, args: { title: out.title, description: out.description, parentGoalId: out.parentGoalId, ownerId: out.ownerId, type: out.type, priority: out.priority, autoAdmit: out.autoAdmit, runOnAssign: out.runOnAssign, prBoundary, autoDeliver: out.autoDeliver, blockedBy: out.blockedBy, repos: out.repos } };
}

/** Shape the POST body: projectId from sync config + the parsed args, omitting absent fields. */
export function buildGoalBody(cfg: SyncConfig, args: GoalCreateArgs): Record<string, unknown> {
  return {
    projectId: cfg.projectId,
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    ...(args.parentGoalId ? { parentGoalId: args.parentGoalId } : {}),
    ...(args.ownerId ? { ownerId: args.ownerId } : {}),
    ...(args.type ? { type: args.type } : {}),
    ...(args.priority ? { priority: args.priority } : {}),
    // Interactive default: send autoAdmit so an AUTO project scopes instantly. `--dormant`
    // (autoAdmit === false) omits it ⇒ the goal is born dormant (TASK-LESS).
    ...(args.autoAdmit === false ? {} : { autoAdmit: true }),
    // Assign-&-run (G#406): `--run`/`--admit-for-owner` admits the goal on `--owner`'s behalf
    // at birth (already running on their fleet), on ANY project mode. Omitted unless opted in.
    ...(args.runOnAssign ? { runOnAssign: true } : {}),
    ...(args.prBoundary ? { prBoundary: true } : {}),
    ...(args.autoDeliver ? { autoDeliver: true } : {}),
    // Multi-repo (epic b2007584): `--repos` forwards a mix of owner/repo names and/or connection
    // UUIDs under the v1 route's `repos` field (resolved to connectionIds server-side). Omitted
    // when absent so the existing single-primary-repo fallback is preserved.
    ...(args.repos && args.repos.length > 0 ? { repos: args.repos } : {}),
  };
}

export interface CreatedGoal {
  id: string;
  title: string;
  /** Set when the goal was admitted at birth (autoAdmit on an AUTO project) ⇒ its scoping
   *  planning task spawned. Null on a dormant create (`--dormant`, or a MANUAL project). */
  admittedAt?: string | null;
  /** Allocated at creation (createEngineGoalWithDisplayNumber, service.ts) — always present
   *  on a real create response; optional here only so a hand-built test fixture may omit it. */
  displayNumber?: number | null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export async function createEngineGoal(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  body: Record<string, unknown>,
): Promise<CreatedGoal> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Goal create failed: ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      if (b?.message) msg += ` — ${b.message}`;
      else if (b?.error) msg += ` — ${b.error}`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: CreatedGoal } | null;
  if (!parsed?.data) {
    throw new Error(`Goal create succeeded (${res.status}) but the response had no goal data`);
  }
  return parsed.data;
}

export function renderCreated(goal: CreatedGoal): string {
  const n = goal.displayNumber != null ? `G#${goal.displayNumber} ` : "";
  const autopilot = goal.admittedAt
    ? "Autopilot on — a scoping `planning` task was spawned; an idle fleet will claim it."
    : "Dormant — no scoping task spawned; queue the goal (or use the default to admit) to start scoping.";
  return `[engine-goal-create] Created ${n}goal "${goal.title}" — ${goal.id}\n\n${autopilot}\n`;
}

// ─── S2: --blocked-by (create a blocks GOAL edge after the goal exists) ────────

/**
 * Create a `blocks` GOAL edge `fromGoalId → toGoalId` via the S2 daemon-token endpoint
 * (`/api/v1/me/engine/goal-edges`). Goal-grain analog of engine-create's `createBlocksEdge`.
 */
export async function createBlocksGoalEdge(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  fromGoalId: string,
  toGoalId: string,
): Promise<void> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goal-edges`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: cfg.projectId, fromGoalId, toGoalId, kind: "blocks" }),
  });
  if (!res.ok) {
    let msg = `goal edge create failed: ${res.status}`;
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

  const parsedArgs = parseArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    process.stderr.write(`[engine-goal-create] ${parsedArgs.error}\n`);
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-goal-create] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-goal-create] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // --parent accepts the same G#<n>/#<n>/bare-<n>/slug/title-fragment/uuid shorthand as
  // engine-goal.ts's <goalId> — resolve it to a real id BEFORE create (the server's
  // parentGoalId is a strict z.string().uuid()).
  const createArgs = { ...parsedArgs.args };
  if (createArgs.parentGoalId) {
    try {
      const parentRef = await resolveGoalRef(fetch, cfg, token, createArgs.parentGoalId);
      createArgs.parentGoalId = parentRef.id;
    } catch (err) {
      process.stderr.write(
        `[engine-goal-create] --parent ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  let goal: CreatedGoal;
  try {
    goal = await createEngineGoal(fetch, cfg, token, buildGoalBody(cfg, createArgs));
  } catch (err) {
    process.stderr.write(`[engine-goal-create] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(renderCreated(goal));

  // S2: record a GOAL dependency if --blocked-by was given. The goal already exists, so an
  // edge failure is a soft failure: report it (exit non-zero) but don't pretend the goal
  // wasn't created — the user can retry the edge. We POST a `blocks` goal edge
  // <blocker> → <new goal>, so the newly-created goal is blocked by the dependency goal.
  // --blocked-by accepts the same G#<n>/#<n>/bare-<n>/slug/title-fragment/uuid shorthand
  // as engine-goal.ts's <goalId>.
  if (parsedArgs.args.blockedBy) {
    const blockerRef = parsedArgs.args.blockedBy;
    try {
      const blocker = await resolveGoalRef(fetch, cfg, token, blockerRef);
      const blockerLabel = goalLabel(blocker);
      const newGoalLabel = goal.displayNumber != null ? `G#${goal.displayNumber}` : goal.id;
      await createBlocksGoalEdge(fetch, cfg, token, blocker.id, goal.id);
      process.stdout.write(
        `\n[engine-goal-create] goal ${newGoalLabel} is now blocked by goal ${blockerLabel} (blocks goal edge added).\n`,
      );
    } catch (err) {
      process.stderr.write(
        `\n[engine-goal-create] Goal created, but --blocked-by ${blockerRef} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-goal-create.ts"))) {
  void run();
}
