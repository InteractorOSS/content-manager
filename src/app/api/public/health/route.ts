import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withPublicCors, publicCorsPreflight } from "@/lib/api-docs/cors";

export const OPTIONS = publicCorsPreflight;

// Health check for Caddy's active upstream monitoring (deploy/caddy/Caddyfile)
// and manual checks. Pings the database so a dead/unreachable Postgres shows
// up as unhealthy rather than a false "the Node process is up" green light.
export const GET = withPublicCors(async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch (e) {
    // This route is unauthenticated (under /api/public) — log the real
    // error server-side but don't leak DB host/connection details to
    // whoever can reach the endpoint.
    console.error("Health check failed", e);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
});
