// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared, dependency-free config helpers for the local engine CLIs.
 *
 * Split out of engine-claim.ts (goal fe6d12af) so engine-reap.ts can import these
 * without creating a cycle: engine-claim.ts's own `run()` needs to call
 * engine-reap.ts's `reapBestEffort` as a preflight, and engine-reap.ts needs these
 * two helpers — engine-claim.ts re-exports them for every existing importer.
 *
 * Sync file resolution supports two locations: `.build/.sync` (canonical, `ibuild`)
 * is checked first, with `.tasks/.sync` (legacy, `itasks`) as a fallback. Use
 * `resolveSyncFile()` to get whichever one is present.
 */

import * as fs from "fs";
import * as path from "path";

export interface SyncConfig {
  baseUrl: string;
  projectId: string;
}

function parseSyncLines(content: string, urlKey: string, projectIdKey: string): SyncConfig | null {
  const lines = content.split("\n");
  const get = (key: string) => {
    const line = lines.find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : null;
  };
  const baseUrl = get(urlKey);
  const projectId = get(projectIdKey);
  if (!baseUrl || !projectId) return null;
  return { baseUrl, projectId };
}

/** Parse `.tasks/.sync` (KEY=value lines) for the base URL + project id. */
export function parseSyncFile(content: string): SyncConfig | null {
  return parseSyncLines(content, "TASKS_SYNC_URL", "TASKS_SYNC_PROJECT_ID");
}

/** Parse `.build/.sync` (KEY=value lines) for the base URL + project id. */
export function parseBuildSyncFile(content: string): SyncConfig | null {
  return parseSyncLines(content, "BUILD_SYNC_URL", "BUILD_SYNC_PROJECT_ID");
}

export interface ResolvedSync {
  path: string;
  cfg: SyncConfig;
}

/**
 * Resolve the sync file for a project root: `.build/.sync` (canonical) first,
 * falling back to the legacy `.tasks/.sync`. Returns `null` if neither exists
 * or neither parses to a valid config.
 */
export function resolveSyncFile(cwd: string): ResolvedSync | null {
  const buildPath = path.join(cwd, ".build", ".sync");
  if (fs.existsSync(buildPath)) {
    const cfg = parseBuildSyncFile(fs.readFileSync(buildPath, "utf8"));
    if (cfg) return { path: buildPath, cfg };
  }
  const legacyPath = path.join(cwd, ".tasks", ".sync");
  if (fs.existsSync(legacyPath)) {
    const cfg = parseSyncFile(fs.readFileSync(legacyPath, "utf8"));
    if (cfg) return { path: legacyPath, cfg };
  }
  return null;
}

/** Read PM_DAEMON_TOKEN, with an actionable error when it's absent. */
export function loadDaemonToken(env: Record<string, string | undefined>): string {
  const token = env.PM_DAEMON_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "PM_DAEMON_TOKEN is not set. Mint a daemon token in the PM UI " +
        "(Settings → Agent Tokens) and add it to .env.local as PM_DAEMON_TOKEN=pm_daemon_…",
    );
  }
  return token;
}

/** Runtime states from which an EngineTask is finished (terminal). Moved here from
 *  engine-finish.ts alongside the config helpers above, for the same cycle-avoidance
 *  reason (engine-reap.ts needs it without importing engine-finish.ts). */
export const TERMINAL_STATES = new Set(["done", "cancelled"]);
