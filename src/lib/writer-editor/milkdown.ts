import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { commonmark, htmlSchema } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { $remark, $view } from "@milkdown/kit/utils";
import { visit } from "unist-util-visit";
import type { Node } from "unist";
import { STRINGIFY_STYLE } from "./markdown";
import { HtmlBlockView } from "./html-block-view";

// The writer editor's Milkdown setup, shared by the /write page and its tests
// so what the tests prove is what the page runs.

/**
 * remark hands an image or link with no title (the common case,
 * `![alt](url)`) to Milkdown as `title: null`, and the image node's schema
 * requires a string, so any post with an untitled image crashed the editor
 * on load. An empty string is what "no title" means to the serializer, so
 * the saved Markdown is unchanged.
 */
const defaultNullAttrs = $remark("interactorNullAttrs", () => () => (tree: Node) => {
  visit(tree, (node: Node & { title?: unknown; alt?: unknown }) => {
    if (node.type !== "image" && node.type !== "link") return;
    if (node.title == null) node.title = "";
    if (node.type === "image" && node.alt == null) node.alt = "";
  });
});

/** Raw HTML blocks (videos, column layouts) shown as what they are. */
const htmlBlockView = $view(htmlSchema.node, () => (node, view, getPos) => new HtmlBlockView(node, view, getPos));

export async function createWriterEditor(
  root: HTMLElement,
  markdown: string,
  onChange?: () => void
): Promise<Editor> {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...STRINGIFY_STYLE }));
      if (onChange) ctx.get(listenerCtx).markdownUpdated(() => onChange());
    })
    .use(defaultNullAttrs)
    .use(commonmark)
    .use(htmlBlockView)
    .use(gfm)
    .use(history)
    .use(listener)
    .create();
}
