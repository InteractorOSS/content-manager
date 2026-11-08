"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { ImagePlus, Loader2 } from "lucide-react";
import { applyEditsToOriginal } from "@/lib/writer-editor/markdown";
import { createWriterEditor } from "@/lib/writer-editor/milkdown";
import { insertMarkdownBlock } from "@/lib/writer-editor/insert";
import { FormatToolbar, type ToolbarAction } from "./format-toolbar";
import { useImagePasteDrop, type UploadImage } from "./use-image-paste-drop";

// THE formatted Markdown editor: the one component both the writer editor
// (/write) and the CMS post editor (/posts/[slug]/edit, /posts/new) render.
// Everything about editing lives here (the Milkdown setup, the toolbar,
// images by button/paste/drop, the HTML-block view); the pages only decide
// what to do with the text (autosave and live sync on /write, the Save Draft
// and Publish buttons in the CMS).
//
// It is a controlled field over Markdown text, with one rule that keeps
// writers' Markdown stable: `onChange` never gets the editor's own
// re-serialization, only the writer's edits patched onto the text as it was
// loaded (applyEditsToOriginal). A post that is opened and saved without edits
// keeps every byte.
//
// `value` changing to something this editor didn't produce (a change made
// elsewhere, a restored revision) reloads it, keeping the scroll position.

export type MarkdownContentEditorHandle = {
  /** Insert Markdown (or raw HTML) as blocks after the cursor's block. */
  insertMarkdown: (markdown: string) => void;
};

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/avif";

export function MarkdownContentEditor({
  value,
  onChange,
  upload,
  canUpload = true,
  imageButton = false,
  extra = [],
  onError,
  readOnly = false,
  toolbarTarget,
  toolbarClassName = "border-b bg-muted/30 px-3 py-2",
  buttonClassName = "h-8 min-w-8 justify-center rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
  surfaceClassName = "min-h-[400px] px-6 py-4 text-sm",
  ref,
}: {
  value: string;
  onChange: (markdown: string) => void;
  upload: UploadImage;
  canUpload?: boolean;
  /** A toolbar button that uploads images from a file picker. */
  imageButton?: boolean;
  /** More toolbar buttons, after Link. */
  extra?: ToolbarAction[];
  onError: (message: string) => void;
  readOnly?: boolean;
  /** Render the toolbar into this element (e.g. a sticky page header). */
  toolbarTarget?: HTMLElement | null;
  toolbarClassName?: string;
  buttonClassName?: string;
  surfaceClassName?: string;
  ref?: Ref<MarkdownContentEditorHandle>;
}) {
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const originalRef = useRef(value);
  const baselineRef = useRef("");
  const lastEmittedRef = useRef(value);
  const applyingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const fileRef = useRef<HTMLInputElement>(null);

  const getEditor = useCallback(() => editorRef.current, []);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || applyingRef.current) return;
    const current = editor.action(getMarkdown());
    const next =
      current === baselineRef.current
        ? originalRef.current
        : applyEditsToOriginal(originalRef.current, baselineRef.current, current).text;
    if (next === lastEmittedRef.current) return;
    lastEmittedRef.current = next;
    onChangeRef.current(next);
  }, []);

  /** Start over from `markdown` as the new original. */
  const load = useCallback((markdown: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const scroll = window.scrollY;
    applyingRef.current = true;
    editor.action(replaceAll(markdown));
    applyingRef.current = false;
    originalRef.current = markdown;
    baselineRef.current = editor.action(getMarkdown());
    lastEmittedRef.current = markdown;
    window.scrollTo(0, scroll);
  }, []);

  const setEditable = useCallback((editable: boolean) => {
    editorRef.current?.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => editable }));
  }, []);

  // Build the editor once its container is on the page.
  useEffect(() => {
    if (!rootEl) return;
    let cancelled = false;
    let created: Editor | null = null;
    (async () => {
      const initial = valueRef.current;
      const editor = await createWriterEditor(rootEl, initial, () => emit());
      created = editor;
      if (cancelled) return void editor.destroy();
      editorRef.current = editor;
      originalRef.current = initial;
      baselineRef.current = editor.action(getMarkdown());
      lastEmittedRef.current = initial;
      if (readOnlyRef.current) setEditable(false);
      // The value may have moved on while the editor was loading.
      if (valueRef.current !== initial) load(valueRef.current);
    })();
    return () => {
      cancelled = true;
      void created?.destroy();
      editorRef.current = null;
    };
  }, [rootEl, emit, load, setEditable]);

  // A value that didn't come from this editor: reload.
  useEffect(() => {
    if (editorRef.current && value !== lastEmittedRef.current) load(value);
  }, [value, load]);

  useEffect(() => setEditable(!readOnly), [readOnly, setEditable]);

  useImperativeHandle(
    ref,
    () => ({
      insertMarkdown: (markdown: string) => {
        const editor = editorRef.current;
        if (editor) insertMarkdownBlock(editor, markdown);
      },
    }),
    []
  );

  const { insertImages, busy } = useImagePasteDrop({
    root: rootEl,
    getEditor,
    upload,
    enabled: canUpload && !readOnly,
    onError,
  });

  const actions: ToolbarAction[] = [
    ...(imageButton && canUpload
      ? [
          {
            label: "Image (or paste / drop one into the text)",
            icon: busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />,
            onClick: () => fileRef.current?.click(),
          },
        ]
      : []),
    ...extra,
  ];

  const toolbar = (
    <>
      <FormatToolbar getEditor={getEditor} extra={actions} className={toolbarClassName} buttonClassName={buttonClassName} />
      <input
        ref={fileRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void insertImages(files);
        }}
      />
    </>
  );

  return (
    <div>
      {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbarTarget === undefined ? toolbar : null}
      <div className="relative">
        {busy && !imageButton && (
          <span className="absolute right-3 top-2 z-10 rounded bg-background/90 px-2 py-0.5 text-xs text-muted-foreground">
            Uploading image…
          </span>
        )}
        <div ref={setRootEl} className={`writer-editor prose-preview ${surfaceClassName}`} />
      </div>
    </div>
  );
}
