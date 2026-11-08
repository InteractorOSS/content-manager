#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local goal-attachments vehicle — pulls a goal's attached files into the
 * worktree so the interactive agent (`claude`) can actually open them.
 *
 * A goal can carry attachments (specs, mockups, sample data) uploaded in the PM
 * UI. The browser download route is cookie-only, so a terminal session has no
 * way to read them.
 *
 * CONTAINER-AWARE RESOLUTION (the #751 fix). Inside a fleet container the run holds
 * only a PROJECT-scoped sync token — it cannot DISCOVER a goal's attachment fileIds
 * (the daemon-only goal/task endpoints 401 on a sync token), so this script must not
 * require PM_DAEMON_TOKEN. It resolves a goal's attachments in this order:
 *
 *   1. STAGED MANIFEST (no API, no token): if the daemon / engine:work already placed
 *      the bytes on disk at `.tasks/attachments/<goalId>/index.json`, list/serve from
 *      that manifest. The bytes are already on disk — `claude` opens them by path.
 *      A `.UNREADABLE` sentinel here means staging FAILED: print a LOUD infra-failure
 *      message (carrying INFRA_FAILURE_MARKER) and exit with the dedicated
 *      INFRA_FAILURE_EXIT code so the failure is machine-detectable. An unreadable
 *      attachment is an INFRA/creds failure to report loudly — NEVER a design
 *      discussion or clarification — so the run stops rather than implementing
 *      against a guessed spec.
 *   2. DAEMON TOKEN (today's behavior): if PM_DAEMON_TOKEN is present and nothing is
 *      staged, discover + download via the two token-authed endpoints:
 *        GET /me/engine/goals/:id            → the goal's `attachments` array
 *        GET /files/:fileId/attachment-bytes → the raw bytes of one attachment
 *      `--download` streams each into `.tasks/attachments/<goalId>/<filename>` and
 *      writes the same `index.json` manifest the daemon emits.
 *   3. SYNC-TOKEN-ONLY + nothing staged: a sync token can't discover fileIds — print a
 *      clear message (attachments are normally pre-staged by the daemon / engine:work).
 *
 * Within (2)/(3) the goal id is taken from an explicit `<goalId>` positional, else the
 * goal of the current `.tasks/.engine` task. Within (1) it's the explicit arg, else the
 * single staged goal dir under `.tasks/attachments/`.
 *
 * Config (`.build/.sync`, or legacy `.tasks/.sync`, for the base URL) is read lazily —
 * only the API paths need it; a staged read works with neither sync file nor any token.
 *
 * Usage:
 *   npm run engine:goal-files                    # list the current run's goal's attachments
 *   npm run engine:goal-files -- <goalId>        # list a specific goal's attachments
 *   npm run engine:goal-files -- --download      # download the current goal's attachments
 *   npm run engine:goal-files -- <goalId> --download
 */

import * as fs from "fs";
import * as path from "path";
import { resolveSyncFile, type SyncConfig } from "./engine-claim";

// ─── Infra-failure signalling (#904) ──────────────────────────────────────────
//
// An unreadable / un-stageable goal attachment is an INFRASTRUCTURE failure (the
// engine couldn't place a referenced spec/mockup on disk — typically lacking
// attachment-capable creds, a 401/403, or a download/manifest write failure), NOT
// a "the goal is vague" design question. It must be reportable LOUDLY and be
// machine-detectable as distinct from every other error path. Two distinct signals:
//
//   - INFRA_FAILURE_MARKER: a stable token embedded in the printed message so a
//     supervisor (or a human scanning logs) can grep for it unambiguously. It is
//     NOT printed by any ordinary error path (bad args, missing .sync, no token).
//   - INFRA_FAILURE_EXIT: a DEDICATED, non-1 exit code reserved for this case, so it
//     is distinguishable from the generic `exit(1)` every other failure path uses.
export const INFRA_FAILURE_MARKER = "ENGINE_ATTACHMENT_INFRA_FAILURE";
export const INFRA_FAILURE_EXIT = 3;

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface GoalFilesArgs {
  /** Explicit goal UUID, or null to resolve from the current `.tasks/.engine` task. */
  goalId: string | null;
  /** Fetch the bytes into `.tasks/attachments/{goalId}/` rather than just listing. */
  download: boolean;
}

export type GoalFilesParse = { ok: true; args: GoalFilesArgs } | { ok: false; error: string };

const USAGE =
  "Usage:\n" +
  "  npm run engine:goal-files                 # list the current run's goal's attachments\n" +
  "  npm run engine:goal-files -- <goalId>     # list a specific goal's attachments\n" +
  "  npm run engine:goal-files -- [goalId] --download   # download into .tasks/attachments/<goalId>/";

/**
 * Parse the optional `<goalId>` positional and the `--download` (`-d`) flag.
 * The goal id is validated server-side (404); this only enforces CLI shape.
 */
export function parseGoalFilesArgs(argv: string[]): GoalFilesParse {
  let goalId: string | null = null;
  let download = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--download" || tok === "-d") {
      download = true;
      continue;
    }
    if (tok.startsWith("--") || (tok.startsWith("-") && tok.length > 1 && !/^-?\d/.test(tok))) {
      return { ok: false, error: `Unknown flag ${tok}\n${USAGE}` };
    }
    if (goalId === null && tok !== "") {
      goalId = tok;
      continue;
    }
    return { ok: false, error: `Unexpected argument "${tok}"\n${USAGE}` };
  }
  return { ok: true, args: { goalId, download } };
}

/** Extract the taskId from a `.tasks/.engine` JSON blob (the run context). */
export function parseEngineTaskId(content: string): string | null {
  try {
    const ctx = JSON.parse(content) as { taskId?: unknown };
    return typeof ctx.taskId === "string" && ctx.taskId ? ctx.taskId : null;
  } catch {
    return null;
  }
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  /** Path (relative to the API base) of the token-authed bytes endpoint. */
  downloadUrl: string;
}

/** Human-readable byte size, e.g. 12.3 KB. Pure. */
export function formatBytes(n: number | null): string {
  if (n == null) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** Render the attachments list. Pure — no I/O — so it's unit-testable. */
export function formatAttachments(goalId: string, attachments: Attachment[], download: boolean): string {
  if (attachments.length === 0) {
    return `[engine-goal-files] Goal ${goalId} has no attachments.\n`;
  }
  const lines = [`[engine-goal-files] Goal ${goalId} — ${attachments.length} attachment(s):`];
  for (const a of attachments) {
    lines.push(
      `  - ${a.filename}  (${a.contentType ?? "?"}, ${formatBytes(a.sizeBytes)})  id=${a.id}`,
    );
  }
  if (!download) {
    lines.push(`(run with --download to fetch them into .tasks/attachments/${goalId}/)`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Resolve the destination path for one attachment:
 * `<attachmentsRoot>/<goalId>/<filename>`. `path.basename` strips any path
 * components from the server-supplied filename (no `../` traversal out of the
 * goal dir).
 */
export function attachmentDestPath(attachmentsRoot: string, goalId: string, filename: string): string {
  const safe = path.basename(filename) || "attachment";
  return path.join(attachmentsRoot, goalId, safe);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A non-OK HTTP response from an attachment fetch/download, carrying the status so callers can
 *  tell a CREDS failure (401/403 — sync-token-only / a token without attachment scope, the #904
 *  fail-loud trigger) apart from a transient one. Mirrors the daemon's `AttachmentHttpError`
 *  (docker/agent/daemon/goal-attachments.ts) — the two builds are kept in lockstep by shape. */
class AttachmentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AttachmentHttpError";
  }
}

/** Is this a missing-/insufficient-attachment-creds failure (401/403)? (#904) */
function isCredsError(err: unknown): boolean {
  return err instanceof AttachmentHttpError && (err.status === 401 || err.status === 403);
}

/** GET /me/engine/tasks/:id → the task's goal id (or null if the task has no goal). Throws on non-OK. */
export async function fetchTaskGoalId(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  taskId: string,
): Promise<string | null> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Task fetch failed: ${res.status}`);
  const body = (await res.json()) as { data?: { goal?: { id?: string } | null } };
  return body.data?.goal?.id ?? null;
}

/** GET /me/engine/goals/:id → the goal's attachments array. Throws on non-OK. */
export async function fetchGoalAttachments(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
): Promise<Attachment[]> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/engine/goals/${goalId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new AttachmentHttpError(`Goal fetch failed: ${res.status}`, res.status);
  const body = (await res.json()) as { data?: { attachments?: Attachment[] } };
  return body.data?.attachments ?? [];
}

/** GET an attachment's raw bytes via its `downloadUrl`. Throws on non-OK. */
export async function downloadAttachmentBytes(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  att: Attachment,
): Promise<Uint8Array> {
  const res = await fetchFn(`${cfg.baseUrl}${att.downloadUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new AttachmentHttpError(`Download of "${att.filename}" failed: ${res.status}`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** The slice of `fs` the write path needs — injectable so the flow is unit-testable. */
export interface MinimalFs {
  mkdirSync(dir: string, opts: { recursive: true }): void;
  writeFileSync(file: string, data: Uint8Array): void;
}

/**
 * Download every attachment into `<attachmentsRoot>/<goalId>/`, creating the
 * directory on demand. Returns the written paths in order. fetch + fs are
 * injected so the list/download flow and the worktree write path are testable
 * without real network or disk.
 */
export async function downloadAttachments(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  goalId: string,
  attachments: Attachment[],
  attachmentsRoot: string,
  fsLike: MinimalFs,
): Promise<string[]> {
  const written: string[] = [];
  for (const att of attachments) {
    const bytes = await downloadAttachmentBytes(fetchFn, cfg, token, att);
    const dest = attachmentDestPath(attachmentsRoot, goalId, att.filename);
    fsLike.mkdirSync(path.dirname(dest), { recursive: true });
    fsLike.writeFileSync(dest, bytes);
    written.push(dest);
  }
  return written;
}

/**
 * One entry in the on-disk `index.json` manifest — what a sync-token-only run reads
 * to enumerate the staged attachments WITHOUT any API call. `stagedPath` is relative
 * to the repo root (the dir that holds `.tasks/`) so it stays portable across the
 * primary clone and a per-goal worktree.
 *
 * This MUST stay byte-compatible with the daemon's manifest
 * (docker/agent/daemon/goal-attachments.ts `ManifestEntry`) — the daemon is a
 * separate build that can't import `scripts/`, so the two formats are kept in lockstep
 * by shape, not by code sharing.
 */
export interface ManifestEntry {
  fileId: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
  stagedPath: string;
}

/**
 * Write the `index.json` manifest enumerating the staged attachments. Shared between
 * `engine:work` (seed-time staging) and `engine:goal-files --download` so both emit
 * the IDENTICAL format the readers consume — and the same format the daemon produces.
 *
 * `attachmentsRoot` is `<repoRoot>/.tasks/attachments`; `writtenPaths[i]` is the
 * absolute path `downloadAttachments` wrote for `attachments[i]`. The manifest's
 * `stagedPath` is hardcoded as `.tasks/attachments/<goalId>/<basename>` (repo-relative,
 * matching the daemon) using the basename actually written, so it always agrees with
 * the file on disk. Returns the manifest path.
 */
export function writeAttachmentsManifest(
  fsLike: MinimalFs,
  attachmentsRoot: string,
  goalId: string,
  attachments: Attachment[],
  writtenPaths: string[],
): string {
  const entries: ManifestEntry[] = attachments.map((att, i) => ({
    fileId: att.id,
    filename: att.filename,
    contentType: att.contentType ?? null,
    sizeBytes: att.sizeBytes ?? null,
    stagedPath: path.join(".tasks", "attachments", goalId, path.basename(writtenPaths[i])),
  }));
  const dir = path.join(attachmentsRoot, goalId);
  fsLike.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "index.json");
  fsLike.writeFileSync(file, new TextEncoder().encode(JSON.stringify({ goalId, attachments: entries }, null, 2)));
  return file;
}

/** The parsed `index.json` manifest: a goalId plus its staged entries. */
export interface Manifest {
  goalId: string;
  attachments: ManifestEntry[];
}

/**
 * Read an on-disk `index.json` manifest — the no-API, no-token enumeration surface for a
 * sync-token-only run. Pure (takes the file contents) so it's unit-testable. Returns null
 * for malformed JSON or a shape that doesn't match what the daemon / `engine:work` /
 * `writeAttachmentsManifest` emit, so the caller can fall back rather than trust garbage.
 */
export function parseManifest(content: string): Manifest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as { goalId?: unknown; attachments?: unknown };
  if (typeof rec.goalId !== "string" || !rec.goalId || !Array.isArray(rec.attachments)) return null;
  const attachments: ManifestEntry[] = [];
  for (const raw of rec.attachments) {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Partial<ManifestEntry>;
    if (typeof e.fileId !== "string" || typeof e.filename !== "string" || typeof e.stagedPath !== "string") {
      return null;
    }
    attachments.push({
      fileId: e.fileId,
      filename: e.filename,
      contentType: typeof e.contentType === "string" ? e.contentType : null,
      sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : null,
      stagedPath: e.stagedPath,
    });
  }
  return { goalId: rec.goalId, attachments };
}

/**
 * Render a staged-manifest listing (pure). The bytes are already on disk at each entry's
 * `stagedPath`, so we point the run straight at the paths — no `--download` needed.
 */
export function formatStagedManifest(goalId: string, entries: ManifestEntry[]): string {
  if (entries.length === 0) {
    return `[engine-goal-files] Goal ${goalId} — staged manifest lists no attachments.\n`;
  }
  const lines = [
    `[engine-goal-files] Goal ${goalId} — ${entries.length} staged attachment(s) ` +
      `(read from disk, no API call):`,
  ];
  for (const e of entries) {
    lines.push(`  - ${e.filename}  (${e.contentType ?? "?"}, ${formatBytes(e.sizeBytes)})  ${e.stagedPath}`);
  }
  lines.push("(already on disk — open them by the paths above.)");
  return lines.join("\n") + "\n";
}

/**
 * Render the LOUD infra-failure message when the `.UNREADABLE` sentinel is present (pure). The
 * goal HAS attachments the engine could not place on disk, so their contents are unknown to this
 * run. This is an INFRASTRUCTURE failure (the engine couldn't fetch/stage a referenced file —
 * lacking attachment-capable creds, a 401/403, a download/manifest write failure), NOT a "the
 * goal is vague" question. The message carries INFRA_FAILURE_MARKER so it is machine-detectable,
 * and it explicitly forbids re-routing the failure into a design discussion / clarification.
 */
export function formatSentinelMessage(goalId: string, sentinelBody: string): string {
  return (
    `[engine-goal-files] ${INFRA_FAILURE_MARKER}: Goal ${goalId} — attachments could NOT be staged ` +
    "(.UNREADABLE present).\n" +
    "\n" +
    sentinelBody.trimEnd() +
    "\n\n" +
    "This is an INFRASTRUCTURE / credentials failure, not a scoping question. The goal carries " +
    "attachment(s) (a spec / mockup / sample data) the engine failed to place on disk — typically " +
    "because it could not fetch them (a 401/403 / missing attachment-capable creds, or a download / " +
    "manifest write failure) — so their names and contents are unknown to this run.\n" +
    "REPORT IT LOUDLY as an infra failure and STOP — fail the run (engine:report --fail) naming " +
    `goalId=${goalId} and the unblock steps above. Do NOT implement against a guessed spec.\n` +
    "Do NOT raise this as a pm_request_design_discussion, a pm_ask_question, or any clarification — " +
    "an unreadable/missing GOAL ATTACHMENT is never a design question; it is an infra fault for an " +
    "operator to fix (re-upload / fix the daemon token / re-run so staging retries).\n"
  );
}

/**
 * Render the message when only a project sync token is available and nothing is staged (pure).
 * A sync token can FETCH attachment bytes (the bytes route is project-scoped) but cannot
 * DISCOVER a goal's attachment fileIds — that needs the daemon token this container omits.
 */
export function formatSyncOnlyMessage(goalId: string | null): string {
  const who = goalId ? `goal ${goalId}` : "this run's goal";
  return (
    `[engine-goal-files] Cannot list ${who}: nothing staged on disk and no daemon token available.\n` +
    "A project sync token (BUILD_SYNC_TOKEN, or legacy TASKS_SYNC_TOKEN) CAN fetch a known attachment's bytes — the bytes route " +
    "(/api/v1/files/:fileId/attachment-bytes) is project-scoped — but it cannot DISCOVER a goal's " +
    "attachment fileIds in the first place; that requires the daemon token, which this container " +
    "deliberately does not hold. So with nothing staged, there is no fileId to fetch.\n" +
    "Attachments are normally PRE-STAGED to .tasks/attachments/<goalId>/ by the daemon (fleet) or " +
    "engine:work (local) at seed time. If you expected attachments here, staging did not run or had " +
    "nothing to stage — re-run engine:work / re-claim the task so staging retries, or set " +
    "PM_DAEMON_TOKEN to list directly.\n" +
    "If this goal's work DEPENDS on an attachment (a spec / mockup / sample data) you cannot now " +
    "read, treat it as an INFRASTRUCTURE / credentials failure: report it LOUDLY and STOP — fail the " +
    `run (engine:report --fail) naming goalId=${goalId ?? "<this run's goal>"}. Do NOT implement ` +
    "against a guessed spec, and do NOT raise it as a pm_request_design_discussion, a pm_ask_question, " +
    "or any clarification — an unreadable/missing GOAL ATTACHMENT is never a design question; it is an " +
    "infra fault for an operator to fix. If the goal has NO attachments, this message is expected — " +
    "proceed normally.\n"
  );
}

/**
 * From the entries directly under `.tasks/attachments/`, the ones that look like a staged
 * goal — i.e. hold a manifest or sentinel. `hasStaged` (an existence check) is injected so
 * this stays pure/testable. The daemon stages ONLY the run's own goal, so there is normally
 * exactly one; >1 is unexpected and the caller treats it as ambiguous.
 */
export function findStagedGoalIds(names: string[], hasStaged: (goalId: string) => boolean): string[] {
  return names.filter((n) => n !== "." && n !== ".." && hasStaged(n));
}

/**
 * Render the `.UNREADABLE` sentinel body (pure). Carries the goalId, the reason, the
 * COUNT + NAMES of the attachments that were expected (when known — they are in the
 * download/manifest-failure paths but NOT when the attachment list itself couldn't be
 * fetched), and how a human unblocks. MUST stay byte-identical to the daemon's sentinel
 * (docker/agent/daemon/goal-attachments.ts `sentinelBody`) — the two are separate builds
 * kept in lockstep by shape, so any edit here must be mirrored there.
 */
export function sentinelBody(goalId: string, reason: string, names?: string[]): string {
  const expected =
    names && names.length > 0
      ? `expected attachments (${names.length}): ${names.join(", ")}\n`
      : "expected attachments: unknown (the goal's attachment list could not be fetched)\n";
  return (
    `goalId=${goalId}\n` +
    `reason: ${reason}\n` +
    expected +
    "\n" +
    "This goal has attachments the engine could not stage to disk, so this run " +
    "cannot read them.\n" +
    "To unblock: ensure the daemon can reach the PM API with its daemon token, then " +
    "re-claim / re-run this task so staging retries.\n"
  );
}

/**
 * Write the `.UNREADABLE` failure sentinel so a run pauses CLEARLY rather than silently
 * proceeding without the spec/mockup it needs. Carries the goalId, the reason, the
 * expected attachment count/names (when known), and how to unblock. Best-effort — a write
 * failure is swallowed (returns false) since staging must never crash its caller.
 * Byte-compatible with the daemon's sentinel.
 */
export function writeUnreadableSentinel(
  fsLike: MinimalFs,
  attachmentsRoot: string,
  goalId: string,
  reason: string,
  names?: string[],
): boolean {
  const body = sentinelBody(goalId, reason, names);
  try {
    const dir = path.join(attachmentsRoot, goalId);
    fsLike.mkdirSync(dir, { recursive: true });
    fsLike.writeFileSync(path.join(dir, ".UNREADABLE"), new TextEncoder().encode(body));
    return true;
  } catch {
    return false;
  }
}

export interface StageResult {
  /** The resolved goal id, or null when the task has no goal / couldn't be resolved. */
  goalId: string | null;
  /** How many attachments were written to disk. */
  staged: number;
  /** Whether a `.UNREADABLE` sentinel was written (resolution/download failed). */
  sentinel: boolean;
  /** #904: a 401/403 (lacking attachment-capable creds) was hit fetching/downloading the goal's
   *  attachments — the goal references a spec/mockup this run can't read. The caller surfaces
   *  this as a loud, creds-specific failure (the daemon turns it into a retryable infra
   *  run_failure; the interactive flow warns the operator) rather than a soft sentinel note. */
  credsFailure?: boolean;
  /** Human-legible reason for `sentinel`/`credsFailure`. */
  reason?: string;
  /** Why staging was a no-op, when it was. */
  skipped?: "no-goal" | "no-attachments";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stage the run's own goal attachments to disk (best-effort; NEVER throws — staging is
 * an optional convenience and must not fail the caller). Mirrors the daemon's
 * `stageGoalAttachments` so the local interactive flow (`engine:work`) and the fleet
 * daemon produce the identical on-disk layout. The contract:
 *  - resolve the goalId (prefer the claim-supplied `goalId`, else the task endpoint);
 *  - fetch the goal's attachments; a goal with none is a no-op (no dir);
 *  - download each into `<attachmentsRoot>/<goalId>/<basename>` and write `index.json`;
 *  - on a resolution/download/manifest failure write a `.UNREADABLE` sentinel.
 *
 * SECURITY: only ever stages the given task's OWN goal; `token` is used only for the
 * fetches and is never written to disk.
 */
export async function stageGoalAttachments(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  opts: { goalId: string | null; taskId: string; attachmentsRoot: string },
  fsLike: MinimalFs,
): Promise<StageResult> {
  const { attachmentsRoot } = opts;

  // 1. Resolve the goalId — prefer the claim-supplied one; else the task endpoint. A
  //    resolution failure leaves no goalId to key a sentinel against, so we can only bail.
  let goalId = opts.goalId;
  if (!goalId) {
    try {
      goalId = await fetchTaskGoalId(fetchFn, cfg, token, opts.taskId);
    } catch {
      return { goalId: null, staged: 0, sentinel: false, skipped: "no-goal" };
    }
  }
  if (!goalId) {
    return { goalId: null, staged: 0, sentinel: false, skipped: "no-goal" };
  }

  // 2. Fetch the goal's attachments. A fetch failure means we can't rule out
  //    attachments — fail SAFE to a clear pause (sentinel) rather than proceed blind.
  let attachments: Attachment[];
  try {
    attachments = await fetchGoalAttachments(fetchFn, cfg, token, goalId);
  } catch (err) {
    const reason = `could not fetch goal attachments (${errMsg(err)})`;
    return {
      goalId,
      staged: 0,
      sentinel: writeUnreadableSentinel(fsLike, attachmentsRoot, goalId, reason),
      reason,
      ...(isCredsError(err) ? { credsFailure: true } : {}),
    };
  }

  // 3. No attachments → no-op (no dir), matching the daemon + the goal-files reader.
  if (attachments.length === 0) {
    return { goalId, staged: 0, sentinel: false, skipped: "no-attachments" };
  }

  // 4. Download each; ANY failure → sentinel (don't leave a partial set unflagged).
  let written: string[];
  try {
    written = await downloadAttachments(fetchFn, cfg, token, goalId, attachments, attachmentsRoot, fsLike);
  } catch (err) {
    const reason = `attachment download failed (${errMsg(err)})`;
    const names = attachments.map((a) => a.filename);
    return {
      goalId,
      staged: 0,
      sentinel: writeUnreadableSentinel(fsLike, attachmentsRoot, goalId, reason, names),
      reason,
      ...(isCredsError(err) ? { credsFailure: true } : {}),
    };
  }

  // 5. Write the manifest — the no-API-call enumeration surface for the run.
  try {
    writeAttachmentsManifest(fsLike, attachmentsRoot, goalId, attachments, written);
  } catch (err) {
    const reason = `manifest write failed (${errMsg(err)})`;
    const names = attachments.map((a) => a.filename);
    return { goalId, staged: written.length, sentinel: writeUnreadableSentinel(fsLike, attachmentsRoot, goalId, reason, names) };
  }

  return { goalId, staged: written.length, sentinel: false };
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

/** List the goalIds with a staged dir (manifest or sentinel) under `attachmentsRoot`. I/O. */
function listStagedGoalIds(attachmentsRoot: string): string[] {
  if (!fs.existsSync(attachmentsRoot)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(attachmentsRoot);
  } catch {
    return [];
  }
  return findStagedGoalIds(names, (g) => {
    const dir = path.join(attachmentsRoot, g);
    return fs.existsSync(path.join(dir, "index.json")) || fs.existsSync(path.join(dir, ".UNREADABLE"));
  });
}

/**
 * Serve a goal's attachments from the staged dir if it exists — no API call, no token. Returns
 * true when it handled the request (printed a listing, or a sentinel pause and exited). Returns
 * false to let the caller fall through to the daemon-token API path (no staged dir, or a manifest
 * too malformed to trust).
 */
function tryStagedRead(attachmentsRoot: string, goalId: string): boolean {
  const goalDir = path.join(attachmentsRoot, goalId);

  // (S3 graceful degradation) sentinel present → the goal HAS attachments we couldn't stage.
  // This is an INFRA/creds failure: print the loud message (carrying INFRA_FAILURE_MARKER) and
  // exit with the DEDICATED INFRA_FAILURE_EXIT code — distinct from the generic exit(1) every
  // other error path uses, so a supervisor can tell an attachment-infra fault apart from a bad
  // arg / missing-config error and surface it as a retryable infra failure (not a soft pause).
  const sentinelPath = path.join(goalDir, ".UNREADABLE");
  if (fs.existsSync(sentinelPath)) {
    let body = "";
    try {
      body = fs.readFileSync(sentinelPath, "utf8");
    } catch {
      /* body stays empty — the framing message still carries the goalId + action */
    }
    process.stderr.write(formatSentinelMessage(goalId, body));
    process.exit(INFRA_FAILURE_EXIT);
  }

  const manifestPath = path.join(goalDir, "index.json");
  if (!fs.existsSync(manifestPath)) return false;
  let manifest: Manifest | null = null;
  try {
    manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = null;
  }
  if (!manifest) {
    process.stderr.write(
      `[engine-goal-files] Staged manifest at ${manifestPath} is unreadable/malformed; ` +
        "falling back to the API (daemon token required).\n",
    );
    return false;
  }
  process.stdout.write(formatStagedManifest(manifest.goalId, manifest.attachments));
  return true;
}

async function run(): Promise<void> {
  const cwd = process.cwd();

  const parsed = parseGoalFilesArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`[engine-goal-files] ${parsed.error}\n`);
    process.exit(1);
  }
  const args = parsed.args;
  const attachmentsRoot = path.join(cwd, ".tasks", "attachments");

  // ── 1. Staged read: if the daemon / engine:work already placed the bytes on disk, serve
  //    them from the manifest with NO API call and NO token. This is the fleet-container path:
  //    a sync-token-only run can't discover fileIds, but it doesn't need to — they're staged.
  let stagedGoalId = args.goalId;
  if (!stagedGoalId) {
    // No explicit goalId → discover the run's own staged goal. The daemon stages only one.
    const discovered = listStagedGoalIds(attachmentsRoot);
    if (discovered.length === 1) stagedGoalId = discovered[0];
    // >1 (unexpected) or 0 → fall through; the API path resolves the goal authoritatively.
  }
  if (stagedGoalId && tryStagedRead(attachmentsRoot, stagedGoalId)) {
    return; // handled from disk (or exited on a sentinel pause)
  }

  // ── 2/3. Nothing staged → the API path. This needs the daemon token to DISCOVER fileIds
  //    (the bytes route accepts the sync token, but discovery does not). Require config first.
  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    process.stderr.write(
      "[engine-goal-files] No sync file found (checked .build/.sync and .tasks/.sync) — run from a synced project root.\n",
    );
    process.exit(1);
  }
  const cfg = resolved.cfg;

  // ── 3. Sync-token-only and nothing staged → we cannot discover fileIds. Print the clear,
  //    actionable message rather than failing opaquely.
  const daemonToken = process.env.PM_DAEMON_TOKEN?.trim();
  if (!daemonToken) {
    process.stderr.write(formatSyncOnlyMessage(args.goalId ?? null));
    process.exit(1);
  }

  // ── 2. Daemon token present → behave exactly as before (daemon-token discovery + download).
  const token = daemonToken;
  try {
    // Resolve the goal id: explicit arg, else the current run's task's goal.
    let goalId = args.goalId;
    if (!goalId) {
      const enginePath = path.join(cwd, ".tasks", ".engine");
      if (!fs.existsSync(enginePath)) {
        process.stderr.write(
          "[engine-goal-files] No goalId given and no active run (.tasks/.engine absent). " +
            "Pass a goal UUID or claim a task first.\n",
        );
        process.exit(1);
      }
      const taskId = parseEngineTaskId(fs.readFileSync(enginePath, "utf8"));
      if (!taskId) {
        process.stderr.write("[engine-goal-files] .tasks/.engine has no taskId — pass a goal UUID explicitly.\n");
        process.exit(1);
      }
      goalId = await fetchTaskGoalId(fetch, cfg, token, taskId);
      if (!goalId) {
        process.stderr.write(
          "[engine-goal-files] The current task belongs to no goal — pass a goal UUID explicitly.\n",
        );
        process.exit(1);
      }
    }

    const attachments = await fetchGoalAttachments(fetch, cfg, token, goalId);
    process.stdout.write(formatAttachments(goalId, attachments, args.download));

    if (args.download && attachments.length > 0) {
      const written = await downloadAttachments(fetch, cfg, token, goalId, attachments, attachmentsRoot, fs);
      // Emit the same index.json manifest engine:work + the daemon write, so a
      // sync-token-only run enumerates these files with no further API call.
      writeAttachmentsManifest(fs, attachmentsRoot, goalId, attachments, written);
      process.stdout.write(`[engine-goal-files] Downloaded ${written.length} file(s):\n`);
      for (const p of written) process.stdout.write(`  ${p}\n`);
    }
  } catch (err) {
    process.stderr.write(`[engine-goal-files] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "engine-goal-files.ts"))) {
  void run();
}
