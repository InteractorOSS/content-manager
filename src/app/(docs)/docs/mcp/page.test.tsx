// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The page imports src/lib/mcp/tools.ts, which imports every /api/cms route
// handler (for delegateToRoute) — none of them are ever CALLED by this page
// (it only reads each tool's static description/inputSchema), but importing
// the modules still runs their top-level `@/lib/guard` -> `@/lib/auth` ->
// next-auth chain, which fails to resolve "next/server" under jsdom. Same
// mocks src/app/api/mcp/route.test.ts uses to load this same import graph.
vi.mock("@/lib/guard", () => ({
  requirePermissionApi: vi.fn(),
  actorFromApiTokenValue: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: {}, isUniqueViolation: () => false }));
vi.mock("@/lib/ai/client", () => ({ aiConfigured: () => false }));
vi.mock("@/lib/ai/style", () => ({ proposeGuideAmendment: vi.fn() }));
vi.mock("@/lib/s3", () => ({
  isS3Configured: () => true,
  uploadToS3: vi.fn(),
}));
// G#26: the social tools (list_social_channels, get_social_network_rules)
// pull in @/lib/interactor, which is "server-only" and throws on import
// without the "react-server" export condition Vitest doesn't set. Mocked so
// loading the tools.ts import graph doesn't throw; nothing here calls it.
vi.mock("@/lib/interactor", () => ({
  InteractorError: class InteractorError extends Error {},
  initiateOAuth: vi.fn(),
  searchServices: vi.fn(async () => []),
  serviceExists: vi.fn(async () => true),
}));
// G#27: mark_social_post_posted pulls in @/lib/social/publisher, which is
// also "server-only" (it calls Interactor Core via executeServiceAction) —
// same reasoning as the @/lib/interactor mock above.
vi.mock("@/lib/social/publisher", () => ({
  markManualTargetPosted: vi.fn(),
  canMarkPosted: vi.fn(),
}));

import { CMS_TOOLS, MCP_SERVER_INSTRUCTIONS } from "@/lib/mcp/tools";
import DocsMcpPage from "./page";

afterEach(() => {
  cleanup();
});

describe("DocsMcpPage", () => {
  it("renders every tool in CMS_TOOLS — the live registry, never a hand-picked subset", () => {
    render(<DocsMcpPage />);
    for (const tool of CMS_TOOLS) {
      expect(document.getElementById(`tool-${tool.name}`), `missing card for ${tool.name}`).not.toBeNull();
    }
  });

  it("renders each tool's own description from the registry", () => {
    render(<DocsMcpPage />);
    // Spot-check one tool's exact registry description appears verbatim.
    const whoami = CMS_TOOLS.find((t) => t.name === "whoami")!;
    expect(screen.getByText(whoami.config.description!)).toBeTruthy();
  });

  it("renders the live server instructions string, not a paraphrase", () => {
    render(<DocsMcpPage />);
    expect(screen.getByText(MCP_SERVER_INSTRUCTIONS)).toBeTruthy();
  });

  it("includes a claude mcp add snippet targeting /api/mcp", () => {
    render(<DocsMcpPage />);
    expect(document.body.textContent).toContain("claude mcp add --transport http cms");
    expect(document.body.textContent).toContain("/api/mcp");
  });
});
