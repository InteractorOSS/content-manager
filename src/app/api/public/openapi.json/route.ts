import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api-docs/openapi";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";

export const OPTIONS = publicCorsPreflight;

// Generated from src/lib/api-docs/spec.ts at request time — never hand-edited
// or checked in as a static file (G#22 D2). Unauthenticated, CORS-enabled.
export const GET = withPublicCors(async function GET() {
  return NextResponse.json(buildOpenApiDocument());
});
