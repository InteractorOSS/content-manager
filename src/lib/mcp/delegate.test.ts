import { describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { delegateToRoute, toToolResult } from "./delegate";
import { MCP_DELEGATE_HEADER } from "@/lib/post-revisions";

describe("delegateToRoute", () => {
  it("marks every delegated request with the MCP delegate header", async () => {
    let seenHeader: string | null = null;
    const handler = async (req: Request) => {
      seenHeader = req.headers.get(MCP_DELEGATE_HEADER);
      return NextResponse.json({ ok: true });
    };

    await delegateToRoute(handler, "token-abc", { method: "GET", path: "/api/cms/posts/1" });

    expect(seenHeader).toBe("1");
  });

  it("also carries the caller's bearer token", async () => {
    let seenAuth: string | null = null;
    const handler = async (req: Request) => {
      seenAuth = req.headers.get("authorization");
      return NextResponse.json({ ok: true });
    };

    await delegateToRoute(handler, "token-abc", { method: "GET", path: "/api/cms/posts/1" });

    expect(seenAuth).toBe("Bearer token-abc");
  });
});

describe("toToolResult", () => {
  it("marks a 4xx/5xx delegated response as an error tool result", () => {
    const result = toToolResult({ status: 404, body: { error: "Not found" } });
    expect(result.isError).toBe(true);
  });

  it("does not mark a 2xx response as an error", () => {
    const result = toToolResult({ status: 200, body: { data: {} } });
    expect(result.isError).toBeUndefined();
  });
});
