// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ENDPOINTS } from "@/lib/api-docs/spec";
import DocsApiPage, { endpointAnchor } from "./page";

afterEach(() => {
  cleanup();
});

describe("DocsApiPage", () => {
  it("renders every group from ENDPOINTS as a section heading — never a hand-picked subset", () => {
    render(<DocsApiPage />);
    const groups = [...new Set(ENDPOINTS.map((e) => e.group))];
    // Read the heading elements directly: a role query computes the role of
    // every node on this (large) page, and one per group ran past vitest's
    // 5 s timeout under full-suite load.
    const headings = new Set(
      [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => h.textContent?.trim())
    );
    for (const group of groups) {
      expect(headings.has(group), `missing heading for ${group}`).toBe(true);
    }
  });

  it("renders every endpoint's method and path — nothing retyped, nothing dropped", () => {
    render(<DocsApiPage />);
    for (const endpoint of ENDPOINTS) {
      const el = document.getElementById(endpointAnchor(endpoint));
      expect(el, `missing card for ${endpoint.method} ${endpoint.path}`).not.toBeNull();
    }
  });

  it("produces clean anchors with no double or trailing hyphens", () => {
    for (const endpoint of ENDPOINTS) {
      const anchor = endpointAnchor(endpoint);
      expect(anchor, `${endpoint.method} ${endpoint.path} -> "${anchor}"`).not.toMatch(/--|-$|^-/);
    }
  });

  it("links to the generated OpenAPI document", () => {
    render(<DocsApiPage />);
    const href = screen.getByRole("link", { name: "GET /api/public/openapi.json" }).getAttribute("href");
    expect(href).toBe("/api/public/openapi.json");
  });
});
