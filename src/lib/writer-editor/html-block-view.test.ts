// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@milkdown/kit/core";
import { getMarkdown } from "@milkdown/kit/utils";
import { createWriterEditor } from "./milkdown";
import { applyEditsToOriginal } from "./markdown";
import { insertImageBlock, insertMarkdownBlock } from "./insert";
import { describeHtmlBlock, youtubeIdOf } from "./html-block-view";

// The HTML the old post editor's toolbar inserted, exactly as it stores it.
const VIDEO = `<div class="video-embed" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;margin:1rem 0;">
            <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" style="position:absolute;top:0;left:0;width:100%;height:100%;" frameborder="0" allowfullscreen></iframe>
          </div>`;
const TWO_COL = `<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0;">
        <div style="min-height:2rem;">Column 1</div>
        <div style="min-height:2rem;">Column 2</div>
      </div>`;
const POST = `Intro paragraph with <sup>1</sup> a footnote.\n\n${VIDEO}\n\n${TWO_COL}\n\nClosing paragraph.`;

let editor: Editor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

async function render(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  editor = await createWriterEditor(root, markdown);
  return { root, editor, baseline: editor.action(getMarkdown()) };
}

describe("HTML blocks in the formatted editor", () => {
  it("shows a video as its thumbnail and a layout in a sandboxed frame, not as raw markup", async () => {
    const { root } = await render(POST);
    const blocks = [...root.querySelectorAll(".html-embed")];
    expect(blocks).toHaveLength(2);
    const img = blocks[0].querySelector("img")!;
    expect(img.src).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    const frame = blocks[1].querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin"); // never allow-scripts
    expect(frame.srcdoc).toContain("Column 1");
    expect(blocks[1].textContent).toContain("2-column layout");
    // HTML inside a sentence stays inline (remark splits it at the tags).
    expect([...root.querySelectorAll(".html-inline")].map((c) => c.textContent)).toEqual(["<sup>", "</sup>"]);
  });

  it("keeps an untouched post byte-for-byte", async () => {
    const { baseline } = await render(POST);
    expect(applyEditsToOriginal(POST, baseline, baseline).text).toBe(POST);
  });

  it("saves an edit made through Edit HTML, and only that", async () => {
    const { root, editor, baseline } = await render(POST);
    const block = root.querySelectorAll(".html-embed")[1] as HTMLElement;
    const edit = [...block.querySelectorAll("button")].find((b) => b.textContent === "Edit HTML")!;
    edit.click();
    const area = block.querySelector("textarea")!;
    area.value = area.value.replace("Column 2", "Pricing");
    [...block.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click();
    const saved = applyEditsToOriginal(POST, baseline, editor.action(getMarkdown())).text;
    expect(saved).toBe(POST.replace("Column 2", "Pricing"));
  });

  it("removes a block with its paragraph", async () => {
    const { root, editor, baseline } = await render(POST);
    const block = root.querySelectorAll(".html-embed")[0] as HTMLElement;
    [...block.querySelectorAll("button")].find((b) => b.textContent === "Remove")!.click();
    const saved = applyEditsToOriginal(POST, baseline, editor.action(getMarkdown())).text;
    expect(saved).not.toContain("youtube");
    expect(saved).toContain(TWO_COL);
  });

  it("names what a block is", () => {
    expect(youtubeIdOf(VIDEO)).toBe("dQw4w9WgXcQ");
    expect(describeHtmlBlock(VIDEO)).toBe("YouTube video");
    expect(describeHtmlBlock(TWO_COL)).toBe("2-column layout");
    expect(describeHtmlBlock("<table></table>")).toBe("HTML block");
  });
});

describe("inserting blocks", () => {
  it("puts a toolbar's HTML block after the cursor's paragraph, as its own block", async () => {
    const { editor, baseline } = await render("First paragraph.\n\nSecond paragraph.\n");
    insertMarkdownBlock(editor, TWO_COL);
    const md = editor.action(getMarkdown());
    expect(md).not.toBe(baseline);
    expect(md).toContain(`\n\n${TWO_COL}\n\n`);
  });

  it("puts an image on its own line", async () => {
    const { editor } = await render("First paragraph.\n");
    insertImageBlock(editor, "/uploads/a.png", "a picture");
    expect(editor.action(getMarkdown())).toContain("First paragraph.\n\n![a picture](/uploads/a.png)");
  });
});
