import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";

// How raw HTML in a post's Markdown shows in the formatted editor. Posts carry
// HTML the old editor's toolbar inserted (YouTube embeds, 2- and 3-column
// layouts); Milkdown keeps each as an `html` node, which by default shows the
// raw markup as text in the middle of the page.
//
// A block of HTML (the only thing in its paragraph) is shown as what it is
// instead: a YouTube embed as the video's thumbnail, anything else rendered
// in a sandboxed frame, so nothing in it can run a script or reach the page.
// It can't be typed into; "Edit HTML" opens its markup in a box, and saving
// that updates the node, which the editor then saves like any other edit.
// HTML inside a sentence (a <sup>, a <br>) stays a small inline chip.

const YOUTUBE_ID = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/;

export function youtubeIdOf(html: string): string | null {
  return YOUTUBE_ID.exec(html)?.[1] ?? null;
}

export function describeHtmlBlock(html: string): string {
  if (youtubeIdOf(html)) return "YouTube video";
  if (/class="three-col"/.test(html)) return "3-column layout";
  if (/class="two-col"/.test(html)) return "2-column layout";
  return "HTML block";
}

export class HtmlBlockView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private editing = false;

  constructor(
    node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined
  ) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.contentEditable = "false";
    this.render();
  }

  /** A block when it is the only thing in its paragraph. */
  private isBlock(): boolean {
    const pos = this.getPos();
    if (pos === undefined) return false;
    const parent = this.view.state.doc.resolve(pos).parent;
    return parent.type.name === "paragraph" && parent.childCount === 1;
  }

  private render() {
    const value = String(this.node.attrs.value ?? "");
    this.dom.replaceChildren();
    if (!this.isBlock()) {
      this.dom.className = "html-inline";
      this.dom.textContent = value;
      this.dom.title = "HTML";
      return;
    }
    this.dom.className = "html-embed";
    this.dom.appendChild(this.bar(value));
    this.dom.appendChild(this.editing ? this.editor(value) : this.preview(value));
  }

  private bar(value: string): HTMLElement {
    const bar = document.createElement("span");
    bar.className = "html-embed-bar";
    const label = document.createElement("span");
    label.textContent = describeHtmlBlock(value);
    bar.appendChild(label);
    if (this.view.editable && !this.editing) {
      bar.appendChild(this.button("Edit HTML", () => this.setEditing(true)));
      bar.appendChild(this.button("Remove", () => this.remove()));
    }
    return bar;
  }

  private preview(value: string): HTMLElement {
    const id = youtubeIdOf(value);
    if (id) {
      const img = document.createElement("img");
      img.src = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
      img.alt = "YouTube video thumbnail";
      img.className = "html-embed-video";
      return img;
    }
    // No allow-scripts: markup is shown, never run. allow-same-origin only so
    // the frame's height can be read to fit its content.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.className = "html-embed-frame";
    frame.srcdoc = `<!doctype html><html><head><style>html{overflow:hidden}body{margin:0;padding:1px 0;font:14px/1.6 system-ui,sans-serif;color:#111}img{max-width:100%}</style></head><body>${value}</body></html>`;
    frame.addEventListener("load", () => {
      // documentElement, not body: the layouts' own top/bottom margins
      // collapse outside <body> and were cut off.
      const h = frame.contentDocument?.documentElement?.scrollHeight;
      if (h) frame.style.height = `${Math.min(h + 4, 800)}px`;
    });
    return frame;
  }

  private editor(value: string): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "html-embed-edit";
    const area = document.createElement("textarea");
    area.value = value;
    area.rows = Math.min(Math.max(value.split("\n").length, 4), 16);
    area.spellcheck = false;
    wrap.appendChild(area);
    const actions = document.createElement("span");
    actions.className = "html-embed-actions";
    actions.appendChild(this.button("Save", () => this.save(area.value), true));
    actions.appendChild(this.button("Cancel", () => this.setEditing(false)));
    wrap.appendChild(actions);
    setTimeout(() => area.focus(), 0);
    return wrap;
  }

  private button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = primary ? "html-embed-btn primary" : "html-embed-btn";
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  private setEditing(on: boolean) {
    this.editing = on;
    this.render();
  }

  private save(value: string) {
    const pos = this.getPos();
    this.editing = false;
    if (pos === undefined) return this.render();
    if (value === this.node.attrs.value) return this.render();
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value }));
  }

  private remove() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const $pos = this.view.state.doc.resolve(pos);
    // Take the paragraph that holds only this block, not just the node.
    const tr = this.isBlock()
      ? this.view.state.tr.delete($pos.before(), $pos.after())
      : this.view.state.tr.delete(pos, pos + this.node.nodeSize);
    this.view.dispatch(tr);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.value !== this.node.attrs.value;
    this.node = node;
    if (changed && !this.editing) this.render();
    return true;
  }

  // Clicks and typing inside the bar or the HTML box are the view's own, not
  // the editor's.
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !!target && (target.tagName === "TEXTAREA" || target.tagName === "BUTTON");
  }

  ignoreMutation(): boolean {
    return true;
  }
}
