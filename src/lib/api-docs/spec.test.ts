// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The drift test (G#22 D3): keeps `spec.ts` honest against the actual route
 * handlers on disk. Walks every `src/app/api/**\/route.ts`, extracts its
 * exported HTTP methods and derives its URL path (`[id]` → `{id}`), and
 * cross-checks the result against `ENDPOINTS` in both directions plus the
 * `UNDOCUMENTED` allowlist — every (path, method) pair found on disk must be
 * accounted for by exactly one of the two, and every `DocEndpoint` must
 * point at a route file that still exists and still exports that method.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { ENDPOINTS, UNDOCUMENTED, type UndocumentedEntry } from "./spec";
import { buildOpenApiDocument } from "./openapi";

const REPO_ROOT = process.cwd();
const API_ROOT = join(REPO_ROOT, "src/app/api");
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkRouteFiles(full, out);
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

/** `src/app/api/cms/posts/[id]/route.ts` → `/api/cms/posts/{id}` */
function derivePath(routeFile: string): string {
  const rel = relative(join(REPO_ROOT, "src/app"), routeFile).replace(/\\/g, "/");
  const withoutFile = rel.replace(/\/route\.ts$/, "");
  const segments = withoutFile.split("/").map((seg) => {
    const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) return `{...${catchAll[1]}}`;
    const dynamic = seg.match(/^\[(.+)\]$/);
    if (dynamic) return `{${dynamic[1]}}`;
    return seg;
  });
  return "/" + segments.join("/");
}

const METHOD_NAME = "GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD";

/**
 * Exported HTTP method handlers. Covers `export async function GET`,
 * `export const GET = ...`, and `export const { GET, POST } = someObject`
 * (used by `src/app/api/auth/[...nextauth]/route.ts`) — the destructuring
 * form has no method name directly after `const`, so it needs its own
 * pattern rather than falling out of the first for free.
 */
function exportedMethods(source: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  const singleRe = new RegExp(`export\\s+(?:async\\s+function|function|const)\\s+(${METHOD_NAME})\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = singleRe.exec(source))) {
    found.add(match[1] as HttpMethod);
  }

  const destructuredRe = /export\s+const\s+\{([^}]+)\}\s*=/g;
  while ((match = destructuredRe.exec(source))) {
    for (const name of match[1].split(",").map((s) => s.trim().split(/[\s:]/)[0])) {
      if (new RegExp(`^(?:${METHOD_NAME})$`).test(name)) found.add(name as HttpMethod);
    }
  }

  return [...found];
}

function undocumentedReason(entry: UndocumentedEntry, path: string, method: HttpMethod): string | null {
  if (entry.method && entry.method !== method) return null;
  if ("path" in entry && entry.path !== undefined) {
    return entry.path === path ? entry.reason : null;
  }
  if ("pathPrefix" in entry && entry.pathPrefix !== undefined) {
    return path.startsWith(entry.pathPrefix) ? entry.reason : null;
  }
  return null;
}

function isAllowedUndocumented(path: string, method: HttpMethod): boolean {
  return UNDOCUMENTED.some((entry) => undocumentedReason(entry, path, method) !== null);
}

const routeFiles = walkRouteFiles(API_ROOT);
const onDisk = routeFiles.map((file) => ({
  file,
  relFile: relative(REPO_ROOT, file),
  path: derivePath(file),
  methods: exportedMethods(readFileSync(file, "utf8")),
}));

describe("API docs drift (G#22 D3)", () => {
  it("covers every route+method on disk with a DocEndpoint or an UNDOCUMENTED reason", () => {
    const uncovered: string[] = [];
    for (const { relFile, path, methods } of onDisk) {
      for (const method of methods) {
        // HEAD is implied by GET (the platform answers it automatically), and
        // OPTIONS is the CORS preflight responder (src/lib/api-docs/cors.ts) —
        // neither is documented as its own DocEndpoint.
        if (method === "HEAD" || method === "OPTIONS") continue;
        const documented = ENDPOINTS.some((e) => e.method === method && e.path === path);
        if (documented) continue;
        if (isAllowedUndocumented(path, method)) continue;
        uncovered.push(`${method} ${path}  (${relFile})`);
      }
    }
    expect(
      uncovered,
      `Route(s) neither documented in spec.ts's ENDPOINTS nor allowlisted in UNDOCUMENTED:\n${uncovered.join("\n")}`
    ).toEqual([]);
  });

  it("every DocEndpoint's routeFile exists, exports that method, and resolves to the declared path", () => {
    const problems: string[] = [];
    for (const endpoint of ENDPOINTS) {
      const full = join(REPO_ROOT, endpoint.routeFile);
      let source: string;
      try {
        source = readFileSync(full, "utf8");
      } catch {
        problems.push(`${endpoint.method} ${endpoint.path}: routeFile "${endpoint.routeFile}" does not exist`);
        continue;
      }

      if (!exportedMethods(source).includes(endpoint.method)) {
        problems.push(`${endpoint.method} ${endpoint.path}: "${endpoint.routeFile}" does not export ${endpoint.method}`);
      }

      const derived = derivePath(full);
      if (derived !== endpoint.path) {
        problems.push(
          `${endpoint.method} ${endpoint.path}: routeFile "${endpoint.routeFile}" resolves to path "${derived}", not "${endpoint.path}"`
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every documented endpoint has at least one example and at least one response", () => {
    const problems: string[] = [];
    for (const e of ENDPOINTS) {
      if (e.examples.length === 0) problems.push(`${e.method} ${e.path}: no examples`);
      if (e.responses.length === 0) problems.push(`${e.method} ${e.path}: no responses`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("generates a structurally valid OpenAPI 3.1 document covering every endpoint", () => {
    const doc = buildOpenApiDocument();

    expect(doc.openapi).toBe("3.1.0");
    expect(typeof doc.info.title).toBe("string");
    expect(doc.info.title.length).toBeGreaterThan(0);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });

    for (const endpoint of ENDPOINTS) {
      const pathItem = (doc.paths as Record<string, Record<string, unknown>>)[endpoint.path];
      expect(pathItem, `missing path "${endpoint.path}" in the generated document`).toBeDefined();
      const operation = pathItem[endpoint.method.toLowerCase()];
      expect(operation, `missing operation ${endpoint.method} ${endpoint.path}`).toBeDefined();
    }
  });
});
