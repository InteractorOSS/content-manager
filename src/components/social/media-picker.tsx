"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import {
  AlertCircle,
  Check,
  Film,
  ImagePlus,
  Loader2,
  Search,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { listMedia, uploadMedia } from "@/lib/api";
import { SOCIAL_MEDIA_ALT_MAX, mediaTypeFromMime } from "@/lib/social/media";
import { cn } from "@/lib/utils";
import type { Media } from "@/types/cms";
import type { SocialMediaAttachment } from "@/types/social";

/**
 * Disabled buttons in the composer keep full opacity (org design guide: no
 * blanket opacity over text) and change surface instead; the in-flight state
 * is also announced through a role="status" line by the caller.
 */
export const DISABLED_BUTTON =
  "disabled:opacity-100 disabled:cursor-not-allowed disabled:border disabled:border-dashed disabled:border-input disabled:bg-muted disabled:text-foreground";

function toAttachment(m: Media): SocialMediaAttachment {
  return {
    media_id: m.id,
    url: m.file_path,
    type: mediaTypeFromMime(m.mime_type) ?? "image",
    ...(m.alt_text ? { alt: m.alt_text } : {}),
  };
}

/** One square preview of a picked file — image, or a labelled video tile. */
function Thumb({ item, className }: { item: { url: string; type?: string; alt?: string }; className?: string }) {
  if (item.type === "video") {
    return (
      <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1 bg-muted text-foreground", className)}>
        <Film className="h-5 w-5 text-muted-foreground" aria-hidden />
        <span className="text-[11px] font-medium">Video</span>
      </div>
    );
  }
  return (
    <img src={item.url} alt={item.alt ?? ""} className={cn("h-full w-full object-cover", className)} />
  );
}

/**
 * The media on a post (or on one channel): an ordered list — order is what a
 * carousel or an X post shows — with each file's alt text editable in place,
 * plus the button that opens the library. Replaces the typed image-URL
 * inputs: a post can only carry files from the org's media library.
 *
 * An item with no `media_id` was saved before the picker and matched no
 * library file by url; it is flagged here for re-picking and the composer
 * won't send it.
 */
export function SocialMediaField({
  value,
  onChange,
  label,
  problems = [],
  idPrefix,
}: {
  value: SocialMediaAttachment[];
  onChange: (next: SocialMediaAttachment[]) => void;
  /** Names the set in button labels, e.g. "post" or "LinkedIn". */
  label: string;
  /** Plain-language reasons this set won't fit a selected network, each
   * already ending in what to do about it. */
  problems?: string[];
  idPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const problemId = `${idPrefix}-media-problems`;

  function setAlt(index: number, alt: string) {
    onChange(
      value.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item };
        if (alt) next.alt = alt;
        else delete next.alt;
        return next;
      })
    );
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ol
          className="divide-y rounded-lg border"
          aria-label={`Media on the ${label}, in order`}
          aria-describedby={problems.length ? problemId : undefined}
        >
          {value.map((item, i) => {
            const altId = `${idPrefix}-alt-${i}`;
            const unresolved = !item.media_id;
            return (
              <li key={`${item.media_id ?? item.url}-${i}`} className="flex items-center gap-3 p-2">
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted">
                  <Thumb item={item} />
                  <span
                    className="absolute bottom-0.5 left-0.5 rounded bg-background px-1 text-[11px] font-semibold tabular-nums text-foreground shadow-sm"
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  {unresolved ? (
                    <p className="flex items-start gap-1.5 text-sm text-foreground">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                      <span>
                        Not in your media library. Remove it and pick the file again from the library.
                      </span>
                    </p>
                  ) : (
                    <>
                      <label htmlFor={altId} className="sr-only">
                        Alt text for item {i + 1} on the {label}
                      </label>
                      <Input
                        id={altId}
                        value={item.alt ?? ""}
                        maxLength={SOCIAL_MEDIA_ALT_MAX}
                        placeholder={item.type === "video" ? "Add a description" : "Add alt text"}
                        onChange={(e) => setAlt(i, e.target.value)}
                        className="h-11 sm:h-9"
                      />
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none ring-offset-background transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label={`Remove item ${i + 1}${item.alt ? ` (${item.alt})` : ""} from the ${label}`}
                  onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {problems.length > 0 && (
        <ul id={problemId} className="space-y-1">
          {problems.map((p) => (
            <li
              key={p}
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-foreground"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        className="h-11 w-full sm:h-9 sm:w-auto"
        onClick={() => setOpen(true)}
      >
        <ImagePlus className="mr-2 h-4 w-4" aria-hidden />
        {value.length ? "Change media" : "Add from media library"}
      </Button>

      <MediaLibraryPicker
        open={open}
        onClose={() => setOpen(false)}
        initial={value}
        onConfirm={(next) => {
          onChange(next);
          setOpen(false);
        }}
      />
    </div>
  );
}

/**
 * The org's media library as a picker: tap to add in order, tap again to
 * remove; upload straight from here. Reuses the /media page's query
 * (`["media"]`, `listMedia`) and upload call, so a file uploaded here shows
 * up in the library and vice versa.
 */
function MediaLibraryPicker({
  open,
  onClose,
  initial,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  initial: SocialMediaAttachment[];
  onConfirm: (next: SocialMediaAttachment[]) => void;
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<SocialMediaAttachment[]>([]);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(initial);
    setSearch("");
    setUploadError(null);
    // Reset only when the dialog opens, not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { data: media = [], isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["media"],
    queryFn: listMedia,
    enabled: open,
  });

  const usable = useMemo(
    () =>
      media.filter((m) => mediaTypeFromMime(m.mime_type) !== null).filter((m) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          m.original_filename?.toLowerCase().includes(q) ||
          m.alt_text?.toLowerCase().includes(q)
        );
      }),
    [media, search]
  );

  function toggle(m: Media) {
    setPicked((current) =>
      current.some((p) => p.media_id === m.id)
        ? current.filter((p) => p.media_id !== m.id)
        : [...current, toAttachment(m)]
    );
  }

  const onDrop = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      setUploadError(null);
      const added: SocialMediaAttachment[] = [];
      let failed = 0;
      for (const file of files) {
        try {
          added.push(toAttachment(await uploadMedia(file)));
        } catch {
          failed += 1;
        }
      }
      setUploading(false);
      // Freshly uploaded files are picked straight away — that's why they
      // were uploaded from here.
      setPicked((current) => [...current, ...added]);
      queryClient.invalidateQueries({ queryKey: ["media"] });
      if (failed) {
        setUploadError(
          `${failed === files.length ? "The upload" : `${failed} of ${files.length} uploads`} didn't go through. Your picks are kept — try uploading ${failed === 1 ? "that file" : "those files"} again, or upload from the Media page.`
        );
      }
    },
    [queryClient]
  );

  const { getRootProps, getInputProps, isDragActive, open: openFileDialog } = useDropzone({
    onDrop,
    accept: { "image/*": [], "video/*": [] },
    noClick: true,
    noKeyboard: true,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1rem)] flex-col gap-4 p-4 sm:max-w-2xl sm:p-6">
        <DialogHeader>
          <DialogTitle>Choose media</DialogTitle>
          <DialogDescription>
            Tap files in the order they should appear. Only images and videos from your media library can go on a post.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              placeholder="Search by file name or alt text"
              aria-label="Search the media library"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 pl-9 sm:h-10"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className={cn("h-11 sm:h-10", DISABLED_BUTTON)}
            onClick={openFileDialog}
            disabled={uploading}
            aria-busy={uploading}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Upload className="mr-2 h-4 w-4" aria-hidden />
            )}
            Upload
          </Button>
        </div>

        <p role="status" className="sr-only">
          {uploading ? "Uploading…" : `${picked.length} selected`}
        </p>

        {uploadError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span>{uploadError}</span>
          </div>
        )}

        <div
          {...getRootProps()}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto rounded-lg border-2 border-dashed p-2 transition-colors",
            isDragActive ? "border-primary bg-primary/5" : "border-transparent"
          )}
        >
          <input {...getInputProps()} aria-label="Upload images or videos" />
          {isLoading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-md" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <AlertCircle className="h-6 w-6 text-destructive" aria-hidden />
              <p className="max-w-sm text-sm">
                The media library didn&apos;t load. Nothing on your post has changed.
              </p>
              <Button
                type="button"
                variant="outline"
                className={cn("h-11 sm:h-9", DISABLED_BUTTON)}
                onClick={() => refetch()}
                disabled={isFetching}
                aria-busy={isFetching}
              >
                Load the library again
              </Button>
            </div>
          ) : usable.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <ImagePlus className="h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="max-w-sm text-sm text-muted-foreground">
                {search
                  ? "No images or videos match that search."
                  : "Your media library has no images or videos yet. Upload one here, or drop files onto this area."}
              </p>
              {!search && (
                <Button type="button" className="h-11 sm:h-9" onClick={openFileDialog}>
                  <Upload className="mr-2 h-4 w-4" aria-hidden />
                  Upload a file
                </Button>
              )}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Media library">
              {usable.map((m) => {
                const position = picked.findIndex((p) => p.media_id === m.id);
                const selected = position >= 0;
                const item = toAttachment(m);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`${m.original_filename}${item.type === "video" ? ", video" : ""}${selected ? `, selected as number ${position + 1}` : ""}`}
                      onClick={() => toggle(m)}
                      className={cn(
                        "relative block aspect-square w-full overflow-hidden rounded-md border bg-muted outline-none ring-offset-background transition-[box-shadow,border-color] duration-150",
                        "hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        selected && "border-primary ring-2 ring-primary"
                      )}
                    >
                      <Thumb item={item} />
                      {selected ? (
                        <span className="absolute right-1 top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-primary-foreground shadow-sm">
                          {position + 1}
                        </span>
                      ) : (
                        <span className="absolute right-1 top-1 h-6 w-6 rounded-full border-2 border-background bg-background/80 shadow-sm" aria-hidden />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:space-x-0">
          <p className="text-sm text-muted-foreground" aria-hidden>
            {picked.length === 0 ? "Nothing selected" : `${picked.length} selected`}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={picked.length === 0 ? "outline" : "default"}
              className={cn("h-11 sm:h-10", DISABLED_BUTTON)}
              disabled={uploading}
              onClick={() => onConfirm(picked)}
            >
              <Check className="mr-2 h-4 w-4" aria-hidden />
              {picked.length === 0 ? "Use no media" : `Use ${picked.length} ${picked.length === 1 ? "file" : "files"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
