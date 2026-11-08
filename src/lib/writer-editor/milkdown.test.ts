// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getMarkdown } from "@milkdown/kit/utils";
import { createWriterEditor } from "./milkdown";
import { applyEditsToOriginal } from "./markdown";

// Through the real editor setup the /write page runs. The fixture carries the
// formatting that broke things against the 25 published posts: an image with
// no title (crashed the editor on load), a table the editor re-pads (pushed
// later edits out of reach), "*" bullets and "***" rules it rewrites, a bare
// URL it wraps in <>, and Windows line endings.
const FIXTURE = [
  "# Enterprise agents",
  "",
  "Intro with a bare link https://example.com/docs and **bold** text.",
  "",
  "![Architecture diagram](https://example.com/diagram.png)",
  "",
  "| Challenge | Today | Next |",
  "|---|---|---|",
  "| **Coordination** | One graph | Many agents |",
  "| Credentials | Env vars | Per-user vaults |",
  "",
  "* first point",
  "* second point",
  "",
  "***",
  "",
  "Closing paragraph about deployment.",
  "",
].join("\r\n");

async function render(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await createWriterEditor(root, markdown);
  return { editor, baseline: editor.action(getMarkdown()) };
}

describe("writer editor setup", () => {
  it("loads a post whose image has no title", async () => {
    const { editor, baseline } = await render(FIXTURE);
    expect(baseline).toContain("![Architecture diagram](https://example.com/diagram.png)");
    await editor.destroy();
  });

  it("re-serializes the post differently — which is why only edits are ever saved", async () => {
    const { editor, baseline } = await render(FIXTURE);
    expect(baseline).not.toBe(FIXTURE);
    expect(baseline).toContain("- first point");
    await editor.destroy();
  });

  it.each([
    ["the heading", "Enterprise", "Distributed"],
    ["a table cell", "Per-user vaults", "Per-user secret vaults"],
    ["the last paragraph", "deployment", "rollout"],
  ])("saves an edit to %s and nothing else", async (_where, from, to) => {
    const { editor, baseline } = await render(FIXTURE);
    const res = applyEditsToOriginal(FIXTURE, baseline, baseline.replace(from, to));
    expect(res).toEqual({ text: FIXTURE.replace(from, to), clean: true });
    await editor.destroy();
  });

  it("saves nothing at all for a post opened but not edited", async () => {
    const { editor, baseline } = await render(FIXTURE);
    expect(applyEditsToOriginal(FIXTURE, baseline, baseline)).toEqual({ text: FIXTURE, clean: true });
    await editor.destroy();
  });
});
