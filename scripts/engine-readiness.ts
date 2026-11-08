#!/usr/bin/env tsx
// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local engine repo-readiness vehicle.
 *
 * The terminal counterpart to the web UI's Readiness panel + Machines page — so the
 * interactive agent (or a developer) can inspect and drive per-repo automation
 * readiness WITHOUT the browser. Composes the same account-level `/me/*` endpoints
 * the panel calls, all reachable with a `pm_daemon_` token:
 *
 *   list                         GET  /me/connected-repos
 *   status <repo|connectionId>   GET  /me/connected-repos/:id/agent-profile
 *   assess <repo|connectionId>   POST /me/connected-repos/:id/assess   (+ poll)
 *
 * `status` prints the all-five-green readiness gate (toolchain / test-tooling /
 * write-access / install / services). `assess` requests a fresh read-only
 * assessment on an idle fleet agent and polls the profile until it settles.
 *
 * Credential + config are shared with engine-claim/work/report: `.build/.sync` (or legacy `.tasks/.sync`)
 * for the base URL, PM_DAEMON_TOKEN from the environment.
 *
 * Usage:
 *   npm run engine:readiness -- list
 *   npm run engine:readiness -- status <owner/repo | repo-substring | connectionId>
 *   npm run engine:readiness -- assess <owner/repo | repo-substring | connectionId>
 */

import * as path from "path";
import { resolveSyncFile, loadDaemonToken, type SyncConfig } from "./engine-claim";

// ─── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface ConnectedRepo {
  connectionId: string;
  repo: string; // "owner/repo"
  projectId: string;
  projectSlug: string;
  orgSlug: string;
  branch: string | null;
  folder: string | null;
}

export interface PreflightCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface ReadinessView {
  resolvedToolchain: string | null;
  toolchainResolvedAt: string | null;
  testToolingDetected: boolean | null;
  writeCapable: boolean | null;
  preflightStatus: string | null;
  preflightChecks: PreflightCheck[] | null;
  preflightCheckedAt: string | null;
  assessRequestedAt: string | null;
  ready: boolean;
}

/**
 * Resolve a user-supplied repo identifier against the connected-repo list.
 * Precedence: exact "owner/repo" > exact connectionId > case-insensitive repo
 * substring (unique). Returns the match, an `{ ambiguous }` set when a substring
 * hits more than one repo, or null when nothing matches.
 */
export function resolveConnection(
  repos: ConnectedRepo[],
  query: string,
): ConnectedRepo | { ambiguous: ConnectedRepo[] } | null {
  const q = query.trim();
  const exactRepo = repos.find((r) => r.repo === q);
  if (exactRepo) return exactRepo;
  const byId = repos.find((r) => r.connectionId === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  const substr = repos.filter((r) => r.repo.toLowerCase().includes(lower));
  if (substr.length === 1) return substr[0];
  if (substr.length > 1) return { ambiguous: substr };
  return null;
}

const MARK = { pass: "✓", fail: "✗", unknown: "?" } as const;

function mark(v: boolean | null | undefined): string {
  if (v === true) return MARK.pass;
  if (v === false) return MARK.fail;
  return MARK.unknown;
}

function preflightMark(checks: PreflightCheck[] | null, id: string): string {
  if (!checks) return MARK.unknown;
  const hit = checks.find((c) => c.check === id);
  if (!hit) return MARK.unknown;
  return hit.ok ? MARK.pass : MARK.fail;
}

function preflightDetail(checks: PreflightCheck[] | null, id: string): string {
  const hit = checks?.find((c) => c.check === id);
  return hit && !hit.ok && hit.detail ? ` — ${hit.detail}` : "";
}

/**
 * Render the all-five-green gate for a repo as a human-readable block. Pure over
 * the readiness view so the formatting is unit-testable without a live server.
 */
export function formatReadiness(repo: string, r: ReadinessView): string {
  // Toolchain has no explicit fail flag — it's resolved (✓) once `toolchainResolvedAt`
  // is stamped, otherwise not-yet-determined (?), matching the tri-state rows below
  // (never a hard ✗, which would misread a never-assessed repo as a failure).
  const toolchain = r.toolchainResolvedAt != null ? true : null;
  const lines = [
    `Readiness for ${repo}: ${r.ready ? "READY ✓" : "NOT READY"}`,
    `  preflightStatus: ${r.preflightStatus ?? "(never assessed)"}`,
    "",
    `  ${mark(toolchain)} toolchain resolved${r.resolvedToolchain ? ` — ${r.resolvedToolchain}` : ""}`,
    `  ${mark(r.testToolingDetected)} test tooling detected`,
    `  ${mark(r.writeCapable)} write access to repo`,
    `  ${preflightMark(r.preflightChecks, "install")} install preflight${preflightDetail(r.preflightChecks, "install")}`,
    `  ${preflightMark(r.preflightChecks, "services")} services preflight${preflightDetail(r.preflightChecks, "services")}`,
  ];
  if (r.assessRequestedAt) {
    lines.push("", `  last assess requested: ${r.assessRequestedAt}`);
  }
  return lines.join("\n");
}

/** A preflightStatus is settled once the daemon has run (or refused) the assess. */
export function isSettledStatus(status: string | null | undefined): boolean {
  return status === "passed" || status === "failed" || status === "blocked_no_compute";
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function fetchConnectedRepos(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
): Promise<ConnectedRepo[]> {
  const res = await fetchFn(`${cfg.baseUrl}/api/v1/me/connected-repos`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`Listing connected repos failed: ${res.status}`);
  const body = (await res.json()) as { data: ConnectedRepo[] };
  return body.data ?? [];
}

export async function fetchReadiness(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  connectionId: string,
): Promise<ReadinessView> {
  const res = await fetchFn(
    `${cfg.baseUrl}/api/v1/me/connected-repos/${connectionId}/agent-profile`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Fetching agent profile failed: ${res.status}`);
  const body = (await res.json()) as { data: { readiness: ReadinessView } };
  return body.data.readiness;
}

export interface AssessResult {
  preflightStatus: string | null;
  assessRequestedAt: string | null;
  writeCapable?: boolean | null;
}

export async function requestAssess(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  connectionId: string,
): Promise<AssessResult> {
  const res = await fetchFn(
    `${cfg.baseUrl}/api/v1/me/connected-repos/${connectionId}/assess`,
    { method: "POST", headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Requesting assessment failed: ${res.status}`);
  const body = (await res.json()) as { data: AssessResult };
  return body.data;
}

/** The setup-lifecycle actions the connection-scoped test-mechanism endpoint accepts —
 *  the headless form of the Readiness panel's action button + draft review. */
export type SetupAction = "recheck" | "accept" | "regenerate";

/**
 * Drive one setup-lifecycle action for a connection (machine-agnostic). `recheck`
 * re-runs the whole pipeline (Set it up / Fix setup / Re-check); `accept` adopts a
 * ready draft; `regenerate` redrafts. Mirrors the panel's connection-scoped POST.
 */
export async function postSetupAction(
  fetchFn: FetchFn,
  cfg: SyncConfig,
  token: string,
  connectionId: string,
  action: SetupAction,
): Promise<void> {
  const res = await fetchFn(
    `${cfg.baseUrl}/api/v1/me/connected-repos/${connectionId}/test-mechanism`,
    { method: "POST", headers: authHeaders(token), body: JSON.stringify({ action }) },
  );
  if (!res.ok) throw new Error(`Setup action "${action}" failed: ${res.status}`);
}

// ─── I/O (thin executable) ────────────────────────────────────────────────────

function loadSync(cwd: string): SyncConfig {
  const resolved = resolveSyncFile(cwd);
  if (!resolved) {
    throw new Error(
      "No sync file found (checked .build/.sync and .tasks/.sync). Run this from the project " +
        "root where the PM bridge config lives.",
    );
  }
  return resolved.cfg;
}

function printRepoList(repos: ConnectedRepo[]): void {
  if (repos.length === 0) {
    console.log("No connected repos for this account.");
    return;
  }
  console.log(`Connected repos (${repos.length}):\n`);
  for (const r of repos) {
    console.log(`  ${r.repo}`);
    console.log(`    project:      ${r.orgSlug}/${r.projectSlug}`);
    console.log(`    connectionId: ${r.connectionId}`);
  }
  console.log("\nRun `npm run engine:readiness -- status <repo>` for the readiness gate.");
}

/** Resolve an identifier arg to a connection, printing an actionable error on miss. */
function requireConnection(repos: ConnectedRepo[], query: string): ConnectedRepo {
  const hit = resolveConnection(repos, query);
  if (!hit) {
    throw new Error(
      `No connected repo matches "${query}". Run \`npm run engine:readiness -- list\` to see them.`,
    );
  }
  if ("ambiguous" in hit) {
    const names = hit.ambiguous.map((r) => r.repo).join(", ");
    throw new Error(`"${query}" is ambiguous — matches: ${names}. Use the full owner/repo.`);
  }
  return hit;
}

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40; // ~2 min, mirrors the web Readiness panel

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAssess(
  cfg: SyncConfig,
  token: string,
  conn: ConnectedRepo,
  opts: { skipRequest?: boolean } = {},
): Promise<number> {
  // `skipRequest` is set when a setup action (recheck/accept/regenerate) already drove the
  // pipeline — we only poll + print the resulting gate, we don't re-request an assessment.
  if (!opts.skipRequest) {
    console.log(`Requesting readiness assessment for ${conn.repo}…`);
    const started = await requestAssess(fetch, cfg, token, conn.connectionId);

    if (started.preflightStatus === "blocked_no_compute") {
      console.log(
        "\nNo agent online to run the assessment. Bring a daemon machine online (idle) and retry.",
      );
      return 1;
    }

    // A fleet agent may have already run this repo (settled status returned synchronously);
    // report it straight away rather than sleeping a poll cycle first.
    if (isSettledStatus(started.preflightStatus)) {
      const r = await fetchReadiness(fetch, cfg, token, conn.connectionId);
      console.log("\n" + formatReadiness(conn.repo, r));
      return r.ready ? 0 : 1;
    }
  }

  process.stdout.write("Assessing");
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await delay(POLL_INTERVAL_MS);
    process.stdout.write(".");
    const r = await fetchReadiness(fetch, cfg, token, conn.connectionId);
    if (isSettledStatus(r.preflightStatus)) {
      console.log("\n");
      console.log(formatReadiness(conn.repo, r));
      return r.ready ? 0 : 1;
    }
  }
  console.log("\n\nStill assessing after ~2 min — the fleet may be busy.");
  console.log(`Check later with: npm run engine:readiness -- status ${conn.repo}`);
  return 1;
}

/** Drive a setup action, then report the gate — the headless analog of the panel
 *  refetching after its action. Only `recheck` re-requests readiness (flips
 *  `preflightStatus` → pending), so only it polls; `accept`/`regenerate` change the
 *  draft loop without moving the gate, so they print the current gate once (polling
 *  would just burn the ~2-min budget waiting for a status that never changes). */
async function runSetupAction(
  cfg: SyncConfig,
  token: string,
  conn: ConnectedRepo,
  action: SetupAction,
): Promise<number> {
  const verb = action === "accept" ? "Adopting setup for" : action === "regenerate" ? "Redrafting setup for" : "Setting up";
  console.log(`${verb} ${conn.repo}…`);
  await postSetupAction(fetch, cfg, token, conn.connectionId, action);

  if (action === "recheck") {
    // recheck flipped preflightStatus → pending; poll the assess to a settled gate.
    return runAssess(cfg, token, conn, { skipRequest: true });
  }
  // accept/regenerate don't move the readiness gate — just print where it stands now.
  const r = await fetchReadiness(fetch, cfg, token, conn.connectionId);
  console.log("\n" + formatReadiness(conn.repo, r));
  return r.ready ? 0 : 1;
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  npm run engine:readiness -- list",
      "  npm run engine:readiness -- status   <owner/repo | repo-substring | connectionId>",
      "  npm run engine:readiness -- assess   <owner/repo | repo-substring | connectionId>",
      "  npm run engine:readiness -- setup    <repo>   # run the whole setup pipeline (recheck)",
      "  npm run engine:readiness -- accept   <repo>   # adopt the proposed build & test setup",
      "  npm run engine:readiness -- regenerate <repo> # throw the draft away and redraft",
    ].join("\n"),
  );
}

async function run(): Promise<void> {
  const [command, target] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    usage();
    process.exit(command ? 0 : 1);
  }

  const cwd = process.cwd();
  const cfg = loadSync(cwd);
  const token = loadDaemonToken(process.env);

  if (command === "list") {
    printRepoList(await fetchConnectedRepos(fetch, cfg, token));
    return;
  }

  const SETUP_ALIASES: Record<string, SetupAction> = {
    setup: "recheck",
    recheck: "recheck",
    accept: "accept",
    regenerate: "regenerate",
  };

  if (command === "status" || command === "assess" || command in SETUP_ALIASES) {
    if (!target) {
      console.error(`\`${command}\` needs a repo identifier.\n`);
      usage();
      process.exit(1);
    }
    const repos = await fetchConnectedRepos(fetch, cfg, token);
    const conn = requireConnection(repos, target);

    if (command === "status") {
      const r = await fetchReadiness(fetch, cfg, token, conn.connectionId);
      console.log(formatReadiness(conn.repo, r));
      process.exit(r.ready ? 0 : 1);
    }

    if (command === "assess") {
      process.exit(await runAssess(cfg, token, conn));
    }

    process.exit(await runSetupAction(cfg, token, conn, SETUP_ALIASES[command]));
  }

  console.error(`Unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("engine-readiness.ts")) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
