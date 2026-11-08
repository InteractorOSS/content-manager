// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CORS for the public READ API only (G#22 D5). `src/app/api/public/**` sent
 * no CORS headers before this, so any browser-side integration failed at the
 * first `fetch` — this is what makes "any app or vibe-coded project can pick
 * it up" literally true for `GET /api/public/*` and `GET /api/public/openapi.json`.
 *
 * Deliberately NOT applied to `/api/cms/*`, `/api/automation/*`, `/api/me`,
 * `/api/mcp` (credentialed surfaces — opening them to browsers would
 * encourage shipping a `cms_pat_` token into client-side JavaScript), nor to
 * the public WRITE endpoints (`POST /api/contacts` etc., and `POST
 * /api/public/posts/[slug]/comments`) — the website posts to those
 * server-side today, and CORS was not asked for there.
 *
 * One helper, used by every public GET route, so "add CORS here" is never a
 * per-route decision that can drift.
 */

import { NextResponse } from "next/server";

const PUBLIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function applyPublicCorsHeaders(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Wrap a public GET route handler so every response it returns — success,
 * a handled error (a plain `return NextResponse.json(...)`), or an UNCAUGHT
 * exception — carries the CORS headers. A CORS-enabled endpoint that only
 * adds the header on its happy path makes the browser report a generic CORS
 * failure instead of surfacing the real 404/400/500 to the calling JS; a
 * thrown error is the sharpest case, since it never reaches the `return` this
 * wrapper sits around at all without the try/catch below.
 */
export function withPublicCors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse> | NextResponse
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return applyPublicCorsHeaders(await handler(...args));
    } catch (e) {
      console.error("Public API route error", e);
      return applyPublicCorsHeaders(NextResponse.json({ error: "Internal server error" }, { status: 500 }));
    }
  };
}

/** The OPTIONS preflight response for a public GET route. */
export function publicCorsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: PUBLIC_CORS_HEADERS });
}
