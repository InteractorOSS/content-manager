// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
  listApiTokens: vi.fn().mockResolvedValue({ data: [] }),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
  listTokenSiteOptions: vi.fn().mockResolvedValue({ data: [] }),
  ApiError: class extends Error {},
}));
vi.mock("@/hooks/use-me", () => ({ useMe: () => ({ me: null, organizations: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ApiTokensManager } = await import("./api-tokens-manager");
const { WRITING_PLUGIN_COMMANDS } = await import("@/lib/writing-plugin");

afterEach(cleanup);

function renderManager() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiTokensManager />
    </QueryClientProvider>
  );
}

describe("Connect Claude card", () => {
  it("leads with the Interactor CMS plugin and its install commands", () => {
    renderManager();
    expect(screen.getByRole("heading", { name: "Write with Claude" })).toBeTruthy();
    for (const command of WRITING_PLUGIN_COMMANDS) {
      expect(screen.getByText(command)).toBeTruthy();
    }
  });

  it("keeps the raw MCP URL, but tucked into a collapsed secondary option", () => {
    renderManager();
    const summary = screen.getByText(/Other ways to connect/);
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain("/api/mcp");
  });
});
