"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, MessageSquarePlus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DISABLED_BUTTON } from "@/components/social/media-picker";
import { cn } from "@/lib/utils";
import { MAX_SOCIAL_PARTS, type SocialPartKind } from "@/lib/social/parts";

/** One part being edited; `key` keeps a row's identity while it moves. */
export interface EditablePart {
  key: string;
  kind: SocialPartKind;
  body: string;
}

// A new part settles in from just above, quickly and with a strong ease-out,
// only when someone adds it (rows keep their key, so a move doesn't replay
// it). `duration-150` also sets a transition duration on every property, so
// reduced motion turns off the transition as well as the animation.
const PART_ENTER =
  "animate-in fade-in-0 slide-in-from-top-1 duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:animate-none motion-reduce:transition-none";

let nextKey = 0;
export function editablePart(kind: SocialPartKind, body = ""): EditablePart {
  nextKey += 1;
  return { key: `part-${nextKey}`, kind, body };
}

/**
 * What follows the message: the replies of a thread, then at most one first
 * comment (src/lib/social/parts.ts). Thread parts can be added, removed and
 * moved; the first comment always goes last, so it has no move buttons.
 *
 * The thin line down the left is the thread itself, drawn the way X draws
 * one: each reply hangs off the post above it. The first comment is set
 * apart from it, because it answers the post rather than continuing it.
 */
export function ThreadPartsEditor({
  parts,
  onChange,
  threadLimit,
  commentLimit,
  noun,
  problems,
}: {
  parts: EditablePart[];
  onChange: (next: EditablePart[]) => void;
  /** Per-reply limit of the strictest selected channel that threads; null = none selected. */
  threadLimit: number | null;
  /** First-comment limit of the strictest selected channel that takes one. */
  commentLimit: number | null;
  /** What one post of the thread is called for the selected channels ("tweet"). */
  noun: string;
  /** Plain-language limit problems for the selected channels. */
  problems: string[];
}) {
  // Announces a move, which otherwise only changes what is where.
  const [announcement, setAnnouncement] = useState("");
  const thread = parts.filter((p) => p.kind === "thread");
  const comment = parts.find((p) => p.kind === "first_comment");
  const full = parts.length >= MAX_SOCIAL_PARTS;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  function update(key: string, body: string) {
    onChange(parts.map((p) => (p.key === key ? { ...p, body } : p)));
  }
  function remove(key: string) {
    onChange(parts.filter((p) => p.key !== key));
  }
  function move(index: number, delta: -1 | 1) {
    const next = [...thread];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    onChange([...next, ...(comment ? [comment] : [])]);
    setAnnouncement(`Moved to ${noun} ${index + delta + 2} of ${thread.length + 1}.`);
  }
  function add(kind: SocialPartKind) {
    const part = editablePart(kind);
    onChange(kind === "thread" ? [...thread, part, ...(comment ? [comment] : [])] : [...thread, part]);
  }

  // A move that has nowhere to go is shown in the muted foreground, not
  // faded: opacity would re-rate the icon against its background.
  const iconButton =
    "h-11 w-11 shrink-0 p-0 disabled:opacity-100 disabled:cursor-not-allowed disabled:text-muted-foreground/60";

  return (
    <div className="space-y-2">
      {thread.length > 0 && (
        <ol aria-label={`Rest of the thread`} className="space-y-3">
          {thread.map((part, i) => {
            const position = i + 2;
            const over = threadLimit !== null && part.body.length > threadLimit;
            const id = `part-${part.key}`;
            return (
              <li
                key={part.key}
                className={cn("relative pl-5", PART_ENTER)}
              >
                {/* The thread line: joins this reply to the post above it. */}
                <span aria-hidden className="absolute bottom-0 left-1.5 top-[-0.75rem] w-px bg-border" />
                <span aria-hidden className="absolute left-[3px] top-[18px] h-2 w-2 rounded-full border border-border bg-background" />
                <div className="flex flex-wrap items-center gap-x-1">
                  <label htmlFor={id} className="mr-auto text-xs font-medium text-muted-foreground">
                    {Noun} {position}
                  </label>
                  <span
                    className={cn(
                      "px-1 text-xs tabular-nums",
                      over ? "font-medium text-red-700 dark:text-red-400" : "text-muted-foreground"
                    )}
                  >
                    {part.body.length}
                    {threadLimit !== null && ` / ${threadLimit}`}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={iconButton}
                    disabled={i === 0}
                    aria-label={`Move ${noun} ${position} up`}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={iconButton}
                    disabled={i === thread.length - 1}
                    aria-label={`Move ${noun} ${position} down`}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={iconButton}
                    aria-label={`Remove ${noun} ${position}`}
                    onClick={() => remove(part.key)}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <Textarea
                  id={id}
                  rows={3}
                  autoFocus={part.body === "" && i === thread.length - 1}
                  aria-invalid={over || undefined}
                  placeholder={`What ${noun} ${position} says`}
                  value={part.body}
                  onChange={(e) => update(part.key, e.target.value)}
                />
              </li>
            );
          })}
        </ol>
      )}

      {comment && (
        <div className={cn("rounded-md border border-dashed p-2", PART_ENTER)}>
          <div className="flex items-center gap-x-1">
            <label htmlFor={`part-${comment.key}`} className="mr-auto text-xs font-medium text-muted-foreground">
              First comment
            </label>
            <span
              className={cn(
                "px-1 text-xs tabular-nums",
                commentLimit !== null && comment.body.length > commentLimit
                  ? "font-medium text-red-700 dark:text-red-400"
                  : "text-muted-foreground"
              )}
            >
              {comment.body.length}
              {commentLimit !== null && ` / ${commentLimit}`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={iconButton}
              aria-label="Remove the first comment"
              onClick={() => remove(comment.key)}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <Textarea
            id={`part-${comment.key}`}
            rows={2}
            autoFocus={comment.body === ""}
            placeholder="Posted under the post once it's live, often a link or hashtags"
            value={comment.body}
            onChange={(e) => update(comment.key, e.target.value)}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-11", DISABLED_BUTTON)}
          disabled={full}
          onClick={() => add("thread")}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {thread.length === 0 ? "Make it a thread" : `Add ${noun}`}
        </Button>
        {!comment && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("h-11", DISABLED_BUTTON)}
            disabled={full}
            onClick={() => add("first_comment")}
          >
            <MessageSquarePlus className="mr-1 h-4 w-4" aria-hidden />
            Add first comment
          </Button>
        )}
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1 text-sm text-red-700 dark:text-red-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
