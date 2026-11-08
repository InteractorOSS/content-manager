import type { Metadata } from "next";
import { WriterEditorLoader } from "@/components/writer/writer-editor-loader";

// The writer editor. Public route: the page holds no data of its own — it
// reads a one-post edit key from the URL fragment (never sent to a server)
// and talks to /api/edit/doc with it. See src/components/writer/writer-editor.tsx.
export const metadata: Metadata = {
  title: "Writing | Interactor CMS",
  robots: { index: false, follow: false },
};

export default function WritePage() {
  return <WriterEditorLoader />;
}
