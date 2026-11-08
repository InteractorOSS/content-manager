#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local engine-task creation vehicle (cutover: daemon-token create path).
 *
 * Mints an EngineTask in the current project via the v2 create endpoint
 * (`POST /api/v2/projects/{projectId}/tasks`), authenticated with the same
 * account-level daemon token the rest of the local engine loop uses
 * (PM_DAEMON_TOKEN). The endpoint accepts a daemon token OR a browser session;
 * a local script has no cookie, so it sends the token. The new task starts in
 * the investigation phase. By default it is parked in `backlog` (#401) — OUT of
 * the daemon's runnable queue, so an idle fleet won't snatch it; you then either
 * `engine:work` it interactively or `engine:queue` it to hand it to the fleet.
 * Pass `--queue` to create it `queued` (immediately fleet-claimable, the old
 * behaviour).
 *
 * Credential + config are shared with engine-claim/engine-work: `.build/.sync` (or legacy `.tasks/.sync`)
 * for the base URL + project id, PM_DAEMON_TOKEN from the environment.
 *
 * Usage:
 *   npm run engine:create -- "<title>"                       # parked in backlog
 *   npm run engine:create -- "<title>" --queue               # queued (fleet-claimable)
 *   npm run engine:create -- "<title>" --type implementation --priority high
 *   npm run engine:create -- "<title>" --desc "longer context" --goal <goalId>
 *
 * `--type` defaults to `implementation` (the common local case). On success it
 * prints the new task's `#<displayNumber>` + id and the next-step hint.
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";
import { resolveGoalRef } from "./engine-goal";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface CreateArgs {
  title: string;
  type: string;
  description?: string;
  priority?: string;
  goalId?: string;
  /** #401: `--queue` ⇒ create `queued` (fleet-claimable). Default (false) parks
   *  the task in `backlog` so the daemon can't claim it until it's promoted. */
  queue?: boolean;
  /** #430: a task ref (`#N` / slug / uuid) the new task should be BLOCKED BY — after
   *  creating the task we add a `blocks` edge `<resolved ref> → <new task>`, so the new
   *  task can't run until the dependency is done. Resolution + the edge happen post-create. */
  blockedBy?: string;
  /** INCIDENT dup #1432 (G#396): `--allow-additional` ⇒ send `allowAdditional: true`, the
   *  ingress opt-out for the duplicate-open-implementation guard. Set it only when this is
   *  genuinely new parallel work; otherwise a duplicate impl task under the goal is refused
   *  with 409 + the existing task list so you claim it with `engine:work` instead. */
  allowAdditional?: boolean;
}

export type ParseResult =
  | { ok: true; args: CreateArgs }
  | { ok: false; error: string };

const USAGE =
  'Usage: npm run engine:create -- "<title>" [--type <task_type>] ' +
  "[--desc <text>] [--priority <low|medium|high|urgent>] [--goal <G#N|#N|slug|uuid>] [--queue] " +
  "[--allow-additional] [--blocked-by <#N|slug|uuid>]";

// Only the string-valued flags live here; `--queue` is a boolean handled
// separately, so this maps to the string keys of CreateArgs (keeps `out[key] = val`
// type-sound now that CreateArgs also has the boolean `queue`).
const FLAG_KEYS: Record<
  string,
  "type" | "description" | "priority" | "goalId" | "blockedBy"
> = {
  "--type": "type",
  "--desc": "description",
  "--priority": "priority",
  "--goal": "goalId",
  "--blocked-by": "blockedBy",
};

/**
 * Parse the CLI args. The first non-flag token is the title; `--type` defaults
 * to `implementation`. Server-side zod validates the enum values (422), so this
 * deliberately doesn't hardcode the enum lists — it only enforces shape.
 */
export function parseArgs(argv: string[]): ParseResult {
  const out: Partial<CreateArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--queue") {
      out.queue = true;
      continue;
    }
    if (tok === "--allow-additional") {
      out.allowAdditional = true;
      continue;
    }
    const key = FLAG_KEYS[tok];
    if (key) {
      const val = argv[++i];
      if (val == null) return { ok: false, error: `Missing value for ${tok}\n${USAGE}` };
      out[key] = val;
      continue;
    }
    if (tok.startsWith("--")) return { ok: false, error: `Unknown flag ${tok}\n${USAGE}` };
    if (out.title === undefined) {
      // An explicitly-passed empty title is a usage error, not a consumed slot —
      // otherwise `engine:create -- "" "Real title"` would swallow "" and then
      // reject the real title as an unexpected argument.
      if (tok === "") return { ok: false, error: `A title is required.\n${USAGE}` };
      out.title = tok;
      continue;
    }
    return { ok: false, error: `Unexpected argument "${tok}"\n${USAGE}` };
  }

  if (!out.title) return { ok: false, error: `A title is required.\n${USAGE}` };
  return {
    ok: true,
    args: { title: out.title, type: out.type ?? "implementation", description: out.description, priority: out.priority, goalId: out.goalId, queue: out.queue, allowAdditional: out.allowAdditional, blockedBy: out.blockedBy },
  };
}

/** Shape the POST body, omitting absent optional fields (matches the route's zod schema). */
export function buildCreateBody(args: CreateArgs): Record<string, string | boolean> {
  return {
    type: args.type,
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.goalId ? { goalId: args.goalId } : {}),
    // #401: default to `backlog`; `--queue` omits it so the route default (`queued`)
    // applies. Sending the explicit value keeps the CLI's intent legible server-side.
    ...(args.queue ? { initialRuntimeState: "queued" } : { initialRuntimeState: "backlog" }),
    // INCIDENT dup #1432 (G#396): opt out of the ingress duplicate-open-implementation
    // guard only when the caller passed --allow-additional (genuinely new parallel work).
    ...(args.allowAdditional ? { allowAdditional: true } : {}),
  };
}

export interface CreatedTask {
  id: string;
  displayNumber: number | null;
  title: string;
  slug?: string | null;
  runtimeState?: string | null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The duplicate-open-implementation 409 body shape returned by the create ingress
 * (INCIDENT dup #1432, G#396): the goal's existing OPEN implementation tasks plus a
 * remediation message telling the caller to claim one with `engine:work`.
 */
export interface ExistingOpenTask {
  id: string;
  displayNumber: number | null;
  title: string;
  runtimeState?: string | null;
}
export interface Duplicate409Body {
  error?: string;
  message?: string;
  existingTasks?: ExistingOpenTask[];
}

/**
 * Format a duplicate-open-implementation 409 for an LLM agent: one line PER existing
 * task showing `#<displayNumber> / title / runtimeState / id` VERBATIM, then the
 * server's remediation message. The point is that the agent SEES the goal's open work
 * in stderr and claims it with `engine:work` rather than retrying and minting a dupe.
 */
export function formatDuplicate409(body: Duplicate409Body): string {
  const tasks = body.existingTasks ?? [];
  const lines = tasks.map((t) => {
    const n = t.displayNumber != null ? `#${t.displayNumber}` : "#?";
    const state = t.runtimeState ?? "unknown";
    return `  ${n}  ${t.title}  [${state}]  ${t.id}`;
  });
  const header =
    `Create refused: 409 ${body.error ?? "duplicate_open_implementation"} — this goal ` +
    `already has open implementation work. Claim it with \`engine:work\` instead of ` +
    `minting a duplicate:`;
  const hint = body.message ? `\n\n${body.message}` : "";
  return `${header}\n${lines.join("\n")}${hint}`;
}

/**
 * POST the create. Returns the created task (reads the `{ data }` envelope).
 * Throws with the server's `message` on a non-OK response — EXCEPT a
 * duplicate-open-implementation 409, whose existing-task list is surfaced verbatim.
 */
export async function createEngineTask(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  body: Record<string, string | boolean>,
): Promise<CreatedTask> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as Duplicate409Body | null;
    // INCIDENT dup #1432 (G#396): SPECIAL-CASE the duplicate-open-implementation 409 —
    // surface the server's existingTasks list VERBATIM (a flat `409 — <message>` throw
    // would drop it) so an agent claims the open work instead of retrying.
    if (res.status === 409 && b?.existingTasks && b.existingTasks.length > 0) {
      throw new Error(formatDuplicate409(b));
    }
    let msg = `Create failed: ${res.status}`;
    if (b?.message) msg += ` — ${b.message}`;
    else if (b?.error) msg += ` — ${b.error}`;
    throw new Error(msg);
  }
  const parsed = (await res.json().catch(() => null)) as { data?: CreatedTask } | null;
  if (!parsed?.data) {
    // A 2xx without the `{ data }` envelope (e.g. a proxy 204 / reshaped body)
    // would otherwise return undefined and crash renderCreated outside the
    // caller's try/catch — surface it as a clean, catchable error instead.
    throw new Error(`Create succeeded (${res.status}) but the response had no task data`);
  }
  return parsed.data;
}

/** Success message: the new `#N`, slug, id, and the next step — which differs by
 *  whether the task was parked in `backlog` (#401) or queued for the fleet. */
export function renderCreated(task: CreatedTask): string {
  const n = task.displayNumber != null ? `#${task.displayNumber} ` : "";
  const slug = task.slug ? ` (${task.slug})` : "";
  const workRef = task.displayNumber != null ? `#${task.displayNumber}` : task.id;
  const head = `[engine-create] Created ${n}${task.title}${slug} — ${task.id}`;
  if (task.runtimeState === "backlog") {
    return (
      `${head}\n` +
      `\nParked in backlog — the fleet won't pick it up.\n` +
      `  Work it yourself:   \`npm run engine:work -- ${workRef}\`\n` +
      `  Hand it to the fleet: \`npm run engine:queue -- ${workRef}\`\n`
    );
  }
  return `${head}\n\nQueued for the fleet. Or start it yourself: \`npm run engine:work -- ${workRef}\`\n`;
}

// ─── #430: --blocked-by (resolve a ref + create the blocks edge) ──────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function looksLikeUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Resolve a `--blocked-by` ref (`#N` / slug / uuid) to a task id. A bare UUID is used
 * directly (the resolver matches `#N`/slug/title, not raw ids; the edges endpoint
 * validates it exists in the project anyway). Otherwise hit the same project-scoped
 * resolve endpoint `engine:work` uses; throws a legible error on ambiguity/not-found.
 */
export async function resolveTaskRef(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  ref: string,
): Promise<string> {
  if (looksLikeUuid(ref)) return ref;
  const url = `${cfg.baseUrl}/api/v1/me/engine/resolve?projectId=${encodeURIComponent(cfg.projectId)}&identifier=${encodeURIComponent(ref)}`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`could not resolve "${ref}": ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    data?: { kind: string; task?: { id: string } };
  } | null;
  const r = body?.data;
  if (r?.kind === "found" && r.task) return r.task.id;
  if (r?.kind === "ambiguous") throw new Error(`"${ref}" matches multiple tasks — be more specific`);
  throw new Error(`"${ref}" matched no task in this project`);
}

/** Create a `blocks` edge `fromTaskId → toTaskId` via the #430 daemon-token endpoint. */
export async function createBlocksEdge(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/edges`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: cfg.projectId, fromTaskId, toTaskId, kind: "blocks" }),
  });
  if (!res.ok) {
    let msg = `edge create failed: ${res.status}`;
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
    process.stderr.write(`[engine-create] ${parsedArgs.error}\n`);
    process.exit(1);
  }

  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-create] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  let token: string;
  try {
    token = loadDaemonToken(process.env);
  } catch (err) {
    process.stderr.write(`[engine-create] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // --goal accepts the same G#<n>/#<n>/bare-<n>/slug/title-fragment/uuid shorthand as its
  // sibling --blocked-by (task ref) — resolve it to a real id BEFORE create (the server's
  // goalId is a strict z.string().uuid()), consistent with engine-goal-create.ts's --parent.
  const createArgs = { ...parsedArgs.args };
  if (createArgs.goalId) {
    try {
      const goalRef = await resolveGoalRef(fetch, cfg, token, createArgs.goalId);
      createArgs.goalId = goalRef.id;
    } catch (err) {
      process.stderr.write(`[engine-create] --goal ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  let task: CreatedTask;
  try {
    task = await createEngineTask(fetch, cfg, token, buildCreateBody(createArgs));
  } catch (err) {
    process.stderr.write(`[engine-create] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(renderCreated(task));

  // #430: record the dependency if --blocked-by was given. The task already exists, so
  // an edge failure is a soft failure: report it (exit non-zero) but don't pretend the
  // task wasn't created — the user can retry the edge once the ref is resolvable.
  if (parsedArgs.args.blockedBy) {
    const ref = parsedArgs.args.blockedBy;
    const workRef = task.displayNumber != null ? `#${task.displayNumber}` : task.id;
    try {
      const fromId = await resolveTaskRef(fetch, cfg, token, ref);
      await createBlocksEdge(fetch, cfg, token, fromId, task.id);
      process.stdout.write(`\n[engine-create] ${workRef} is now blocked by ${ref} (blocks edge added).\n`);
    } catch (err) {
      process.stderr.write(
        `\n[engine-create] Task created, but --blocked-by ${ref} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-create.ts"))) {
  void run();
}
