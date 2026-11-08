"use client";

import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { insertImageBlock } from "@/lib/writer-editor/insert";

// Images into the formatted editor: pasted, dropped, or picked with a button.
// Each is uploaded (by the page's own `upload`) and put in as its own
// paragraph. Paste and drop are caught in the capture phase, before the
// editor would paste the file's name as text. Shared by /write and the CMS
// post editor.

export type UploadImage = (file: File) => Promise<{ url: string; alt: string }>;

export function altFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
}

export function useImagePasteDrop(opts: {
  root: HTMLElement | null;
  getEditor: () => Editor | null;
  upload: UploadImage;
  enabled: boolean;
  onError: (message: string) => void;
}) {
  const { root, getEditor, upload, enabled, onError } = opts;
  const [busy, setBusy] = useState(false);

  const insertImages = useCallback(
    async (files: File[], at?: number) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length || !enabled) return;
      setBusy(true);
      try {
        for (const file of images) {
          const img = await upload(file);
          const editor = getEditor();
          if (!editor) return;
          insertImageBlock(editor, img.url, img.alt, at);
          at = undefined; // the next one goes after this one
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : "Couldn't upload the image.");
      } finally {
        setBusy(false);
      }
    },
    [enabled, getEditor, onError, upload]
  );

  useEffect(() => {
    if (!root || !enabled) return;
    const imagesOf = (list: FileList | undefined | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesOf(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      void insertImages(files);
    };
    const onDrop = (e: DragEvent) => {
      const files = imagesOf(e.dataTransfer?.files);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const view = getEditor()?.action((ctx) => ctx.get(editorViewCtx));
      void insertImages(files, view?.posAtCoords({ left: e.clientX, top: e.clientY })?.pos);
    };
    root.addEventListener("paste", onPaste, true);
    root.addEventListener("drop", onDrop, true);
    return () => {
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("drop", onDrop, true);
    };
  }, [root, enabled, getEditor, insertImages]);

  return { insertImages, busy };
}
