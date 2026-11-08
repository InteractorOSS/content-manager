import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { markdownToSlice } from "@milkdown/kit/utils";

// Putting things into the formatted editor as blocks of their own: images,
// and anything written as Markdown (a video embed's HTML, a column layout).
// Inserted at the cursor they would sit inline, glued to the sentence
// ("text.![alt](url)"), so they go in place of an empty paragraph or right
// after the block the cursor is in. Shared by /write and the CMS post editor.

function insertBlocks(view: EditorView, nodes: ProseNode[], at?: number): void {
  if (!nodes.length) return;
  let state = view.state;
  let tr: Transaction = state.tr;
  if (at !== undefined) {
    const $at = state.doc.resolve(Math.min(Math.max(at, 0), state.doc.content.size));
    tr = tr.setSelection(TextSelection.near($at));
    state = state.apply(tr);
    tr = state.tr;
  }
  const { $from } = state.selection;
  if ($from.depth > 0 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    tr = tr.replaceWith($from.before(), $from.after(), nodes);
  } else {
    tr = tr.insert($from.depth > 0 ? $from.after(1) : $from.pos, nodes);
  }
  view.dispatch(tr.scrollIntoView());
}

/** An image as its own paragraph, at `at` (a document position) or the cursor. */
export function insertImageBlock(editor: Editor, src: string, alt: string, at?: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { image, paragraph } = view.state.schema.nodes;
    insertBlocks(view, [paragraph.create(null, image.create({ src, alt, title: "" }))], at);
    view.focus();
  });
}

/** Markdown (including raw HTML) as blocks of their own, after the cursor's block. */
export function insertMarkdownBlock(editor: Editor, markdown: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const slice = markdownToSlice(markdown)(ctx);
    const nodes: ProseNode[] = [];
    slice.content.forEach((n) => nodes.push(n));
    insertBlocks(view, nodes);
    view.focus();
  });
}
