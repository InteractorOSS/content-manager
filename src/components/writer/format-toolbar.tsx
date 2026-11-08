"use client";

import { useState } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  toggleLinkCommand,
  turnIntoTextCommand,
} from "@milkdown/kit/preset/commonmark";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import { callCommand } from "@milkdown/kit/utils";
import { Bold, Italic, Heading2, Heading3, Pilcrow, List, ListOrdered, Quote, Link as LinkIcon, Undo2, Redo2 } from "lucide-react";

// The formatting toolbar of the formatted Markdown editor, shared by the
// writer editor (/write) and the CMS post editor. `extra` buttons (images,
// videos, column layouts) go after Link, before Undo/Redo.

export type ToolbarAction = { label: string; icon: React.ReactNode; onClick: () => void; text?: string };

export function FormatToolbar({
  getEditor,
  extra = [],
  className = "",
  buttonClassName = "rounded p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900",
}: {
  getEditor: () => Editor | null;
  extra?: ToolbarAction[];
  className?: string;
  buttonClassName?: string;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");

  const run = (cmd: Parameters<typeof callCommand>[0], payload?: unknown) => {
    const editor = getEditor();
    editor?.action(callCommand(cmd as never, payload as never));
    editor?.action((ctx) => ctx.get(editorViewCtx).focus());
  };

  const applyLink = () => {
    const href = linkHref.trim();
    if (href) run(toggleLinkCommand.key, { href });
    setLinkOpen(false);
    setLinkHref("");
  };

  const tools: ToolbarAction[] = [
    { label: "Bold (⌘B)", icon: <Bold className="h-4 w-4" />, onClick: () => run(toggleStrongCommand.key) },
    { label: "Italic (⌘I)", icon: <Italic className="h-4 w-4" />, onClick: () => run(toggleEmphasisCommand.key) },
    { label: "Heading", icon: <Heading2 className="h-4 w-4" />, onClick: () => run(wrapInHeadingCommand.key, 2) },
    { label: "Subheading", icon: <Heading3 className="h-4 w-4" />, onClick: () => run(wrapInHeadingCommand.key, 3) },
    { label: "Normal text", icon: <Pilcrow className="h-4 w-4" />, onClick: () => run(turnIntoTextCommand.key) },
    { label: "Bulleted list", icon: <List className="h-4 w-4" />, onClick: () => run(wrapInBulletListCommand.key) },
    { label: "Numbered list", icon: <ListOrdered className="h-4 w-4" />, onClick: () => run(wrapInOrderedListCommand.key) },
    { label: "Quote", icon: <Quote className="h-4 w-4" />, onClick: () => run(wrapInBlockquoteCommand.key) },
    { label: "Link", icon: <LinkIcon className="h-4 w-4" />, onClick: () => setLinkOpen((o) => !o) },
    ...extra,
    { label: "Undo (⌘Z)", icon: <Undo2 className="h-4 w-4" />, onClick: () => run(undoCommand.key) },
    { label: "Redo (⇧⌘Z)", icon: <Redo2 className="h-4 w-4" />, onClick: () => run(redoCommand.key) },
  ];

  return (
    <div className={`flex flex-wrap items-center gap-0.5 ${className}`} role="toolbar" aria-label="Formatting">
      {tools.map((t) => (
        <button
          key={t.label}
          type="button"
          title={t.label}
          aria-label={t.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={t.onClick}
          className={`flex items-center gap-1 ${buttonClassName}`}
        >
          {t.icon}
          {t.text && <span className="text-xs">{t.text}</span>}
        </button>
      ))}
      {linkOpen && (
        <span className="ml-2 flex items-center gap-1">
          <input
            autoFocus
            value={linkHref}
            onChange={(e) => setLinkHref(e.target.value)}
            onKeyDown={(e) => {
              // Not a <form>: the CMS post editor already sits inside one.
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                setLinkOpen(false);
              }
            }}
            placeholder="https://…"
            className="w-56 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900"
          />
          <button type="button" onClick={applyLink} className="rounded bg-gray-900 px-2 py-1 text-xs text-white">
            Link
          </button>
        </span>
      )}
    </div>
  );
}
