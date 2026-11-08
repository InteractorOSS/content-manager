"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Sparkles, Trash2, X } from "lucide-react";
import { PostSocialPanel } from "@/components/social/post-social-panel";
import {
  altFromFilename,
  generateTitleCard,
  uploadImage,
  type WriterDetails,
  type WriterOptions,
} from "./writer-api";

// The writer editor's side drawer: the post's Details (featured image, URL,
// category, tags, sites, search snippet) and its Social copy. Details edits
// go back to the editor, which saves them with the post through its one save
// path (same version check, same revision checkpoints); social copy saves on
// its own, per network, through /api/edit/social.

export type DrawerTab = "details" | "social";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function PostDrawer(props: {
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onClose: () => void;
  editKey: string;
  details: WriterDetails;
  onDetails: (patch: Partial<WriterDetails>) => void;
  options: WriterOptions | null;
  published: boolean;
  readOnly: boolean;
  onTrash: () => void;
}) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[420px] flex-col border-l border-gray-200 bg-white shadow-xl"
      aria-label="Post details"
    >
      <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-2">
        {(["details", "social"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => props.onTab(t)}
            className={`rounded px-3 py-1 text-sm ${props.tab === t ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}
          >
            {t === "details" ? "Details" : "Social"}
          </button>
        ))}
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close"
          className="ml-auto rounded p-1.5 text-gray-500 hover:bg-gray-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {props.tab === "details" ? <DetailsTab {...props} /> : <PostSocialPanel
            draftsUrl="/api/edit/social"
            placesUrl="/api/edit/social/destinations"
            headers={{ Authorization: `Bearer ${props.editKey}` }}
            readOnly={props.readOnly}
          />}
      </div>
    </aside>
  );
}

/** A labelled field. `group` for one holding several controls (buttons,
 *  checkboxes): a <label> around those would route every click on its
 *  blank space to the first of them. */
function Field({
  label,
  hint,
  group,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  group?: boolean;
  children: React.ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="mb-5 block" {...(group && { role: "group", "aria-label": label })}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </Tag>
  );
}

const inputClass = "w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-gray-500";

function DetailsTab(props: Parameters<typeof PostDrawer>[0]) {
  const { details, onDetails, options, readOnly, editKey } = props;
  const [slug, setSlug] = useState(details.slug);
  const [imageBusy, setImageBusy] = useState<"" | "upload" | "generate">("");
  const [imageError, setImageError] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // A slug changed elsewhere (or by a save) shows up here unless the writer
  // is mid-way through typing an invalid one.
  useEffect(() => {
    setSlug((s) => (SLUG_RE.test(s) || s === "" ? details.slug : s));
  }, [details.slug]);

  const slugValid = SLUG_RE.test(slug);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setImageBusy("upload");
    setImageError("");
    try {
      const img = await uploadImage(editKey, file, details.featured_image_alt || altFromFilename(file.name));
      onDetails({
        featured_image: img.url,
        ...(!details.featured_image_alt.trim() && { featured_image_alt: img.alt_text ?? altFromFilename(file.name) }),
      });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Couldn't upload the image.");
    } finally {
      setImageBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onGenerate = async () => {
    setImageBusy("generate");
    setImageError("");
    try {
      const img = await generateTitleCard(editKey);
      onDetails({
        featured_image: img.url,
        ...(!details.featured_image_alt.trim() && { featured_image_alt: img.alt_text ?? "" }),
      });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Couldn't make a title card.");
    } finally {
      setImageBusy("");
    }
  };

  const addTag = (raw: string) => {
    const next = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !details.tags.includes(t));
    if (next.length) onDetails({ tags: [...details.tags, ...next] });
    setTagDraft("");
  };

  const toggleSite = (slugName: string) => {
    const has = details.platforms.includes(slugName);
    if (has && details.platforms.length === 1) return; // a post needs at least one site
    onDetails({ platforms: has ? details.platforms.filter((s) => s !== slugName) : [...details.platforms, slugName] });
  };

  const descLength = details.meta_description.length;

  return (
    <fieldset disabled={readOnly} className="min-w-0">
      <Field
        group
        label="Featured image"
        hint="Shown at the top of the post, as its thumbnail in lists, and when the post is shared."
      >
        <div className="overflow-hidden rounded-md border border-gray-200 bg-gray-50">
          {details.featured_image ? (
            <img src={details.featured_image} alt={details.featured_image_alt} className="aspect-[1200/630] w-full object-cover" />
          ) : (
            <div className="flex aspect-[1200/630] items-center justify-center text-xs text-gray-400">No featured image</div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {options?.can_upload !== false && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!imageBusy}
              className="flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50"
            >
              {imageBusy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
              Upload
            </button>
          )}
          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={!!imageBusy}
            className="flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50"
          >
            {imageBusy === "generate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate title card
          </button>
          {details.featured_image && (
            <button
              type="button"
              onClick={() => onDetails({ featured_image: "" })}
              className="rounded-md px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100"
            >
              Remove
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        {imageError && <span className="mt-1 block text-xs text-red-600">{imageError}</span>}
      </Field>

      {details.featured_image && (
        <Field label="Image description (alt text)" hint="What the image shows, for screen readers and search.">
          <input
            value={details.featured_image_alt}
            onChange={(e) => onDetails({ featured_image_alt: e.target.value })}
            className={inputClass}
          />
        </Field>
      )}

      <Field
        label="URL slug"
        hint={
          !slugValid ? (
            <span className="text-red-600">Lowercase letters, numbers and single hyphens only, like my-first-post.</span>
          ) : props.published ? (
            "This post is published: changing the slug changes its address, and the old one stops working."
          ) : (
            "The last part of the post's address."
          )
        }
      >
        <input
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            if (SLUG_RE.test(e.target.value)) onDetails({ slug: e.target.value });
          }}
          className={`${inputClass} font-mono ${slugValid ? "" : "border-red-400"}`}
        />
      </Field>

      <Field label="Category">
        <select value={details.category} onChange={(e) => onDetails({ category: e.target.value })} className={inputClass}>
          <option value="">None</option>
          {options?.categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
          {details.category && !options?.categories.some((c) => c.slug === details.category) && (
            <option value={details.category}>{details.category}</option>
          )}
        </select>
      </Field>

      <Field group label="Tags" hint="Press Enter or type a comma to add one.">
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-gray-300 px-1.5 py-1 focus-within:border-gray-500">
          {details.tags.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => onDetails({ tags: details.tags.filter((x) => x !== t) })}
                className="text-gray-500 hover:text-gray-900"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            list="writer-tag-suggestions"
            onChange={(e) => (e.target.value.includes(",") ? addTag(e.target.value) : setTagDraft(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(tagDraft);
              } else if (e.key === "Backspace" && !tagDraft && details.tags.length) {
                onDetails({ tags: details.tags.slice(0, -1) });
              }
            }}
            onBlur={() => tagDraft.trim() && addTag(tagDraft)}
            className="min-w-[6rem] flex-1 py-0.5 text-sm outline-none"
          />
          <datalist id="writer-tag-suggestions">
            {options?.tags.filter((t) => !details.tags.includes(t)).map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
      </Field>

      <Field group label="Sites" hint="Where this post appears. At least one.">
        <div className="space-y-1">
          {(options?.sites ?? details.platforms.map((s) => ({ name: s, slug: s }))).map((s) => (
            <label key={s.slug} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={details.platforms.includes(s.slug)} onChange={() => toggleSite(s.slug)} />
              {s.name}
              <span className="font-mono text-xs text-gray-400">{s.slug}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field
        label="Search description"
        hint={
          <span className={descLength > 160 ? "text-amber-700" : undefined}>
            {descLength}/160 · The snippet search engines and link previews show. Falls back to the excerpt.
          </span>
        }
      >
        <textarea
          value={details.meta_description}
          onChange={(e) => onDetails({ meta_description: e.target.value })}
          rows={3}
          className={inputClass}
        />
      </Field>

      <Field label="Keywords" hint="Comma-separated, optional.">
        <input value={details.meta_keywords} onChange={(e) => onDetails({ meta_keywords: e.target.value })} className={inputClass} />
      </Field>

      {options?.can_delete && (
        <div className="mt-8 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={props.onTrash}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" /> Move to trash
          </button>
          <p className="mt-1 text-xs text-gray-500">You can restore it from the post list&apos;s Trash for 30 days.</p>
        </div>
      )}
    </fieldset>
  );
}
