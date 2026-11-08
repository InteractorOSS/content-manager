import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: (fn: unknown) => fn,
  oidcEnabled: false,
}));

import { handle } from "./proxy";

function unauthenticatedRequest(pathname: string) {
  const req = new NextRequest(`https://cms.interactor.com${pathname}`);
  return Object.assign(req, { auth: null });
}

describe("proxy public-path allowlist", () => {
  it("lets an unauthenticated visitor reach /docs with no redirect", () => {
    const res = handle(unauthenticatedRequest("/docs"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets an unauthenticated visitor reach nested /docs pages with no redirect", () => {
    const res = handle(unauthenticatedRequest("/docs/auth"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects an unrelated unauthenticated page to /login", () => {
    const res = handle(unauthenticatedRequest("/dashboard"));
    expect(res.headers.get("location")).toBe("https://cms.interactor.com/login");
  });

  it("lets Interactor's OAuth return land on the channel callback instead of a JSON 401", () => {
    // A browser navigation at the end of a provider handshake. The handler does
    // its own session check and sends a signed-out member to sign-in with a way
    // back here; the generic /api/* gate below would answer with bare JSON.
    const res = handle(
      unauthenticatedRequest("/api/social/channels/callback/ch_1?credential_id=c1")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still gates the rest of the social API on a session", () => {
    const res = handle(unauthenticatedRequest("/api/social/channels"));
    expect(res.status).toBe(401);
  });

  it("lets an unauthenticated visitor reach the front page instead of bouncing to sign-in", () => {
    const res = handle(unauthenticatedRequest("/"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not open a lookalike path that merely shares the /docs prefix", () => {
    const res = handle(unauthenticatedRequest("/docsync"));
    expect(res.headers.get("location")).toBe("https://cms.interactor.com/login");
  });

  it("lets an unauthenticated visitor reach the public blog, its posts and feeds", () => {
    for (const path of ["/blog", "/blog/seo-aeo-geo-every-post", "/blog/rss.xml", "/robots.txt"]) {
      expect(handle(unauthenticatedRequest(path)).headers.get("location")).toBeNull();
    }
  });

  it("does not open a lookalike path that merely shares the /blog prefix", () => {
    const res = handle(unauthenticatedRequest("/blogs-admin"));
    expect(res.headers.get("location")).toBe("https://cms.interactor.com/login");
  });
});
