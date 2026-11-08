"use client";

import dynamic from "next/dynamic";

// The editor needs the DOM (ProseMirror) and reads the URL fragment, so it
// renders client-only.
export const WriterEditorLoader = dynamic(
  () => import("./writer-editor").then((m) => m.WriterEditor),
  { ssr: false }
);
