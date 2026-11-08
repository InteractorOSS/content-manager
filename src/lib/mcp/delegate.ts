import { NextRequest, NextResponse } from "next/server";
import { AsyncLocalStorage } from "node:async_hooks";
import { MCP_DELEGATE_HEADER } from "@/lib/post-revisions";
import { WORKSPACE_HEADER } from "@/lib/workspaces";

/**
 * The workspace the current MCP tool call named (every tool takes an optional
 * `workspace`, see defineTool in tools.ts). Carried to the delegated route as
 * a header, where the guard resolves it; kept here rather than threaded
 * through every tool's call so no tool can forget it.
 */
export const toolWorkspace = new AsyncLocalStorage<string | null>();

/**
 * In-process delegation from MCP tools to the existing /api/cms route
 * handlers. Each tool synthesizes a NextRequest carrying the caller's
 * `Authorization: Bearer cms_pat_...` header and invokes the imported route
 * handler directly — no HTTP round-trip, and exactly one implementation of
 * every business rule (RBAC via requirePermissionApi, tenant scoping,
 * sanitization, publish gating). The MCP layer is transport only.
 */

type RouteHandler<P> = (
  req: NextRequest,
  ctx: { params: Promise<P> }
) => Promise<NextResponse> | NextResponse;

export type DelegateOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path is informational (handlers route by export, not URL) but query params ARE read via req.nextUrl. */
  path: string;
  query?: Record<string, string | undefined>;
  /** JSON body — mutually exclusive with formData. */
  body?: unknown;
  /** Multipart body (media upload) — content-type boundary is set by the runtime. */
  formData?: FormData;
  /** Dynamic segment params the handler expects ({ id: ... }). */
  params?: Record<string, string>;
};

export type DelegateResult = { status: number; body: unknown };

export async function delegateToRoute<P extends Record<string, string>>(
  handler: RouteHandler<P>,
  token: string,
  opts: Omit<DelegateOptions, "params"> & { params?: P }
): Promise<DelegateResult> {
  const url = new URL(opts.path, "http://mcp.internal");
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  // Marks the request as MCP-delegated so a route can attribute a resulting
  // post revision to source="mcp" rather than the generic "api" a bare PAT
  // call gets (see src/lib/post-revisions.ts). This is an audit label, not a
  // trust boundary — a direct REST caller setting the same header would only
  // mislabel its own revision's `source`, nothing permission- or tenancy-related.
  const headers = new Headers({ authorization: `Bearer ${token}`, [MCP_DELEGATE_HEADER]: "1" });
  const workspace = toolWorkspace.getStore();
  if (workspace) headers.set(WORKSPACE_HEADER, workspace);
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }

  const req = new NextRequest(url, { method: opts.method, headers, body });
  // A route that throws (e.g. Prisma P2025 from deleting a nonexistent or
  // other-tenant row) must NOT escape as a raw JSON-RPC internal error — that
  // would leak DB error text to the client and break the REST-parity contract
  // of toToolResult. Log it server-side, hand the client a generic failure.
  let res;
  try {
    res = await handler(req, { params: Promise.resolve((opts.params ?? {}) as P) });
  } catch (e) {
    console.error(`[mcp] delegated ${opts.method} ${opts.path} threw:`, e);
    return { status: 500, body: { error: "Internal error" } };
  }

  return {
    status: res.status,
    body: res.status === 204 ? { ok: true } : await res.json(),
  };
}

/**
 * Shape a delegated route response as an MCP tool result. Route-level
 * failures (401/403/404/409/400) come back as isError tool results so the
 * LLM sees exactly what the REST API would have said, instead of a thrown
 * protocol error.
 */
export function toToolResult(result: DelegateResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.body, null, 2) }],
    ...(result.status >= 400 && { isError: true }),
  };
}
