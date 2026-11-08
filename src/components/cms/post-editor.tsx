"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bold,
  Italic,
  Heading2,
  List,
  Link2,
  ImageIcon,
  SquarePlay,
  Columns2,
  Columns3,
  ArrowLeft,
  Share2,
  Sparkles,
  Loader2,
  X,
  Plus,
  Save,
  Globe,
  Archive,
  Send,
  History,
  Eye,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ApiError,
  createPost,
  updatePost,
  generateSeo,
  checkPostSeo,
  generateFeaturedImage,
  uploadImage,
  searchTags,
  listCategories,
  listContentTypes,
  listSites,
  createCategory,
  publishPost,
  unpublishPost,
  workflowAction,
  createPreviewLink,
  revokePreviewLink,
} from "@/lib/api";
import {
  MarkdownContentEditor,
  type MarkdownContentEditorHandle,
} from "@/components/writer/markdown-content-editor";
import { postSaveConflictMessage } from "@/lib/post-save-conflict";
import { useMe } from "@/hooks/use-me";
import { AiFinalizeDialog } from "@/components/cms/ai-finalize-dialog";
import { AiSocialFanoutDialog } from "@/components/cms/ai-social-fanout-dialog";
import { PostSocialPanel } from "@/components/social/post-social-panel";
import { PostHistoryDialog } from "@/components/cms/post-history-dialog";
import { generateSlug } from "@/lib/utils";
import { DEFAULT_SITE_SLUGS } from "@/lib/sites";
import { contentTypeSchema } from "@/lib/content-types";
import { Checkbox } from "@/components/ui/checkbox";
import type { Post, Category, ContentType, Site, SeoGenerateResponse } from "@/types/cms";
import type { BlogRevision } from "@/types/ai";

function handleSaveError(error: unknown, fallback: string) {
  const conflict = postSaveConflictMessage(error);
  if (conflict) {
    toast.error(conflict, { action: { label: "Reload", onClick: () => window.location.reload() } });
    return;
  }
  // A 400 here is the server naming a specific reason a save was refused
  // (e.g. "Content is required to publish a post", "An image is required to
  // publish a post") — show that instead of a generic failure so the user
  // knows what to fix.
  if (error instanceof ApiError && error.status === 400) {
    toast.error(error.message || fallback);
    return;
  }
  toast.error(fallback);
}

const postSchema = z.object({
  title: z.string().min(1, "Title is required"),
  slug: z.string().min(1, "Slug is required").max(100),
  content: z.string().default(""),
  excerpt: z.string().default(""),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  type: contentTypeSchema.default("blog"),
  featured_image: z.string().default(""),
  featured_image_alt: z.string().default(""),
  meta_description: z.string().default(""),
  meta_keywords: z.string().default(""),
  seo_title: z.string().default(""),
  canonical_url: z.string().default(""),
  og_image: z.string().default(""),
  og_image_alt: z.string().default(""),
  noindex: z.boolean().default(false),
  answer_summary: z.string().default(""),
  redirect_to: z.string().default(""),
  mark_updated: z.boolean().default(false),
  author_name: z.string().default(""),
  published_at: z.string().default(""),
  tags: z.array(z.string()).default([]),
  // Plain strings, not a z.enum: the valid set is now this org's site registry
  // (G#18), which is fetched at runtime, so the client cannot close over it at
  // module load. The server re-validates against the org's own slugs.
  platforms: z
    .array(z.string())
    .min(1, "Select at least one site")
    .default([...DEFAULT_SITE_SLUGS]),
  category_id: z.string().default(""),
});

type PostFormInput = z.input<typeof postSchema>;
type PostForm = z.output<typeof postSchema>;

interface PostEditorProps {
  post?: Post;
}

// No POST_TYPES constant any more (G#19): the options come from the org's
// content-type registry at runtime. Nothing in this editor branches on the
// value — a content type changes which posts are grouped together, never
// which fields this form shows.

export function PostEditor({ post }: PostEditorProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const editorRef = useRef<HTMLDivElement>(null);
  const mdRef = useRef<HTMLTextAreaElement>(null);
  // The formatted Markdown editor (the content area for Markdown posts).
  const mdEditorRef = useRef<MarkdownContentEditorHandle>(null);
  // New posts default to markdown (D2 — "markdown-first for new content");
  // an existing post keeps whatever format it was saved with. The format is
  // fixed once a post exists — converting an HTML post's rich layout
  // (grid divs, iframes) to markdown is lossy, so we don't offer it.
  const [contentFormat, setContentFormat] = useState<"markdown" | "html">(
    post?.content_format === "html" ? "html" : "markdown"
  );
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageAlt, setImageAlt] = useState("");
  const [imageUploading, setImageUploading] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [showCatInput, setShowCatInput] = useState(false);
  const [generatingSeo, setGeneratingSeo] = useState(false);
  // AI SEO assist (G#35): the draft is held here, never written to the form,
  // until the writer explicitly accepts a field in the Suggestions panel.
  const [seoSuggestions, setSeoSuggestions] = useState<SeoGenerateResponse["data"] | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(post?.preview_url ?? null);
  // The hash sent as expected_content_hash on the NEXT save — must track the
  // server's value after every successful write, not stay pinned to the
  // value this component mounted with. Without this, a second save in the
  // same session always sends the pre-first-save hash and 409s against
  // itself (there's no router.refresh()/prop update between saves).
  const [contentHash, setContentHash] = useState<string | null>(post?.content_hash ?? null);
  // Continuous learning (Phase D): set when an AI polish revision is applied,
  // so the next save can snapshot the baseline for that profile. Cleared
  // once saved — it should only stamp the post that was just applied.
  const [aiSnapshot, setAiSnapshot] = useState<{ profile_id: string; content: string } | null>(null);

  const { data: categories = [], refetch: refetchCategories } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => listCategories(),
  });

  // Suggestions only — the type field accepts a value that is not in this
  // list, so an empty or failed fetch degrades to a plain text input rather
  // than blocking the save.
  const { data: contentTypes = [] } = useQuery<ContentType[]>({
    queryKey: ["content-types"],
    queryFn: () => listContentTypes(),
  });

  // Distribution targets for this org (G#18). Same degrade-gracefully contract
  // as contentTypes above: the list drives the checkboxes, and the server is
  // what actually validates the chosen slugs.
  const { data: sites = [] } = useQuery<Site[]>({
    queryKey: ["sites"],
    queryFn: () => listSites(),
  });

  // Search & AI readiness (G#32) — the same check the publish/approve gate
  // runs, against the LAST SAVED version of the post. Not live-as-you-type:
  // the check reads content_html, which for markdown posts only exists after
  // a save renders it — a client-side approximation over raw markdown source
  // would silently disagree with what the gate actually checks.
  const {
    data: readiness,
    isFetching: checkingReadiness,
    refetch: refetchReadiness,
  } = useQuery({
    queryKey: ["post-seo-check", post?.id],
    queryFn: () => checkPostSeo(post!.id),
    enabled: false,
  });

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<PostFormInput, unknown, PostForm>({
    resolver: zodResolver(postSchema),
    defaultValues: {
      title: post?.title ?? "",
      slug: post?.slug ?? "",
      content: post?.content ?? "",
      excerpt: post?.excerpt ?? "",
      status: post?.status ?? "draft",
      type: post?.type ?? "blog",
      featured_image: post?.featured_image ?? "",
      featured_image_alt: post?.featured_image_alt ?? "",
      meta_description: post?.meta_description ?? "",
      meta_keywords: post?.meta_keywords ?? "",
      seo_title: post?.seo_title ?? "",
      canonical_url: post?.canonical_url ?? "",
      og_image: post?.og_image ?? "",
      og_image_alt: post?.og_image_alt ?? "",
      noindex: post?.noindex ?? false,
      answer_summary: post?.answer_summary ?? "",
      redirect_to: post?.redirect_to ?? "",
      mark_updated: false,
      author_name: post?.author_name ?? "",
      published_at: post?.published_at
        ? post.published_at.slice(0, 16)
        : "",
      tags: post?.tags ?? [],
      platforms: post?.platforms ?? [...DEFAULT_SITE_SLUGS],
      category_id: post?.category_id ?? "",
    },
  });

  const tags = watch("tags") ?? [];
  const title = watch("title");
  const slug = watch("slug");
  const currentStatus = watch("status");

  // Auto-generate slug from title (only when slug hasn't been manually set)
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(!!post?.slug);
  useEffect(() => {
    if (!slugManuallyEdited && title) {
      setValue("slug", generateSlug(title));
    }
  }, [title, slugManuallyEdited, setValue]);

  // Markdown mode's formatted editor writes the field through setValue, so
  // register it explicitly (there's no input element to bind).
  useEffect(() => {
    register("content");
  }, [register]);

  // Sync editor ref content to form on mount (HTML mode only).
  useEffect(() => {
    if (contentFormat === "html" && editorRef.current && post?.content) {
      editorRef.current.innerHTML = post.content;
    }
  }, [post?.content, contentFormat]);

  const saveMutation = useMutation({
    mutationFn: async (data: PostForm) => {
      const content =
        contentFormat === "markdown" ? data.content : editorRef.current?.innerHTML ?? "";
      const payload = {
        ...data,
        content,
        // Markdown mode's Textarea is RHF-bound directly; HTML mode reads
        // the contenteditable ref. The server renders markdown to
        // content_html on write (see src/lib/markdown.ts).
        content_format: contentFormat,
        // Continuous learning (Phase D): only stamp the AI baseline when the
        // saved content is still exactly the applied revision — if the
        // author kept editing after applying, that content is already their
        // own, not a fresh AI baseline to diff against.
        ...(aiSnapshot &&
          aiSnapshot.content === content && { ai_snapshot: aiSnapshot }),
      };
      if (post?.id) {
        return updatePost(post.id, { ...payload, expected_content_hash: contentHash });
      }
      return createPost(payload);
    },
    onSuccess: (saved) => {
      toast.success(post ? "Post updated" : "Post created");
      setAiSnapshot(null);
      setContentHash(saved.content_hash);
      queryClient.invalidateQueries({ queryKey: ["posts"] });
      if (!post) {
        router.push(`/posts/${saved.slug}/edit`);
      }
    },
    onError: (error) => handleSaveError(error, "Failed to save post"),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      // Save first
      const formData = {
        title,
        slug,
        content: contentFormat === "markdown" ? watch("content") : editorRef.current?.innerHTML ?? "",
        content_format: contentFormat,
        excerpt: watch("excerpt"),
        status: "published" as const,
        type: watch("type"),
        featured_image: watch("featured_image"),
        featured_image_alt: watch("featured_image_alt"),
        meta_description: watch("meta_description"),
        meta_keywords: watch("meta_keywords"),
        seo_title: watch("seo_title"),
        canonical_url: watch("canonical_url"),
        og_image: watch("og_image"),
        og_image_alt: watch("og_image_alt"),
        noindex: watch("noindex"),
        answer_summary: watch("answer_summary"),
        redirect_to: watch("redirect_to"),
        mark_updated: watch("mark_updated"),
        author_name: watch("author_name"),
        published_at: watch("published_at"),
        tags: watch("tags"),
        platforms: watch("platforms"),
        category_id: watch("category_id"),
      };
      if (post?.id) {
        // Update contentHash as soon as this save lands, not only in
        // onSuccess — if the subsequent publishPost call fails, the save
        // itself still happened, and the next save must send the hash it
        // actually produced rather than the pre-save one.
        const updated = await updatePost(post.id, { ...formData, expected_content_hash: contentHash });
        setContentHash(updated.content_hash);
        return publishPost(post.id);
      } else {
        const saved = await createPost(formData);
        return publishPost(saved.id);
      }
    },
    onSuccess: (saved) => {
      toast.success("Post published");
      setContentHash(saved.content_hash);
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: (error) => handleSaveError(error, "Failed to publish post"),
  });

  const unpublishMutation = useMutation({
    mutationFn: () => unpublishPost(post!.id),
    onSuccess: () => {
      toast.success("Post unpublished");
      setValue("status", "draft");
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
    onError: () => toast.error("Failed to unpublish post"),
  });

  const submitReviewMutation = useMutation({
    mutationFn: async (data: PostForm) => {
      // Save first so the reviewer sees the latest content.
      const payload = {
        ...data,
        content: contentFormat === "markdown" ? data.content : editorRef.current?.innerHTML ?? "",
        content_format: contentFormat,
      };
      const saved = post?.id
        ? await updatePost(post.id, { ...payload, expected_content_hash: contentHash })
        : await createPost(payload);
      // Same reasoning as publishMutation: update contentHash as soon as
      // this save lands, not only in onSuccess, in case workflowAction fails.
      setContentHash(saved.content_hash);
      return workflowAction(saved.id, "submit");
    },
    onSuccess: (saved) => {
      toast.success("Post submitted for review");
      setContentHash(saved.content_hash);
      queryClient.invalidateQueries({ queryKey: ["posts"] });
      if (!post) {
        router.push(`/posts/${saved.slug}/edit`);
      }
    },
    onError: (error) => handleSaveError(error, "Failed to submit post for review"),
  });

  const createPreviewLinkMutation = useMutation({
    mutationFn: () => createPreviewLink(post!.id),
    onSuccess: ({ url }) => {
      setPreviewUrl(url);
      toast.success("Preview link created");
    },
    onError: () => toast.error("Failed to create preview link"),
  });

  const revokePreviewLinkMutation = useMutation({
    mutationFn: () => revokePreviewLink(post!.id),
    onSuccess: () => {
      setPreviewUrl(null);
      toast.success("Preview link revoked");
    },
    onError: () => toast.error("Failed to revoke preview link"),
  });

  // Editor toolbar commands (HTML/contenteditable mode)
  function execCommand(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
  }

  function insertHtml(html: string) {
    editorRef.current?.focus();
    document.execCommand("insertHTML", false, html);
  }

  // Editor toolbar commands (Markdown/Textarea mode) — operate on the
  // current selection/cursor in mdRef, mirroring GitHub-style MD toolbars.
  function mdWrapSelection(before: string, after: string, placeholder: string) {
    const el = mdRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd, value } = el;
    const selected = value.slice(selectionStart, selectionEnd) || placeholder;
    const next = value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd);
    setValue("content", next, { shouldDirty: true });
    requestAnimationFrame(() => {
      el.focus();
      const cursor = selectionStart + before.length + selected.length + after.length;
      el.setSelectionRange(cursor, cursor);
    });
  }

  function mdPrefixLine(prefix: string) {
    const el = mdRef.current;
    if (!el) return;
    const { selectionStart, value } = el;
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    setValue("content", next, { shouldDirty: true });
    requestAnimationFrame(() => {
      el.focus();
      const cursor = selectionStart + prefix.length;
      el.setSelectionRange(cursor, cursor);
    });
  }

  // Markdown passes raw HTML blocks through untouched (CommonMark), and the
  // server sanitizes the rendered output same as HTML mode — so embeds and
  // grid layouts reuse the exact same markup as an escape hatch (see
  // FILE-BASED-CONTENT-PLAN.md "Grid layouts / iframes in Markdown").
  function mdInsertBlock(block: string) {
    if (mdEditorRef.current) {
      mdEditorRef.current.insertMarkdown(block);
      return;
    }
    const el = mdRef.current;
    if (!el) return;
    const { selectionStart, value } = el;
    const needsLeadingBreak = selectionStart > 0 && value[selectionStart - 1] !== "\n";
    const insertion = `${needsLeadingBreak ? "\n\n" : ""}${block}\n\n`;
    const next = value.slice(0, selectionStart) + insertion + value.slice(selectionStart);
    setValue("content", next, { shouldDirty: true });
    requestAnimationFrame(() => {
      el.focus();
      const cursor = selectionStart + insertion.length;
      el.setSelectionRange(cursor, cursor);
    });
  }

  function insertBold() {
    if (contentFormat === "markdown") mdWrapSelection("**", "**", "bold text");
    else execCommand("bold");
  }

  function insertItalic() {
    if (contentFormat === "markdown") mdWrapSelection("*", "*", "italic text");
    else execCommand("italic");
  }

  function insertHeading() {
    if (contentFormat === "markdown") mdPrefixLine("## ");
    else insertHtml("<h2><br></h2>");
  }

  function insertList() {
    if (contentFormat === "markdown") mdPrefixLine("- ");
    else execCommand("insertUnorderedList");
  }

  function insertLink() {
    const url = prompt("Enter URL:");
    if (!url) return;
    if (contentFormat === "markdown") mdWrapSelection("[", `](${url})`, "link text");
    else execCommand("createLink", url);
  }

  const YOUTUBE_EMBED_HTML = (id: string) =>
    `<div class="video-embed" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;margin:1rem 0;">
            <iframe src="https://www.youtube.com/embed/${id}" style="position:absolute;top:0;left:0;width:100%;height:100%;" frameborder="0" allowfullscreen></iframe>
          </div>`;

  function insertYoutube() {
    const url = prompt("Enter YouTube URL:");
    if (!url) return;
    const id = url.match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([^&\s]+)/
    )?.[1];
    if (!id) return;
    if (contentFormat === "markdown") mdInsertBlock(YOUTUBE_EMBED_HTML(id));
    else insertHtml(YOUTUBE_EMBED_HTML(id));
  }

  const TWO_COL_HTML = `<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0;">
        <div style="min-height:2rem;">Column 1</div>
        <div style="min-height:2rem;">Column 2</div>
      </div>`;

  const THREE_COL_HTML = `<div class="three-col" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin:1rem 0;">
        <div style="min-height:2rem;">Column 1</div>
        <div style="min-height:2rem;">Column 2</div>
        <div style="min-height:2rem;">Column 3</div>
      </div>`;

  function insertTwoCol() {
    if (contentFormat === "markdown") mdInsertBlock(TWO_COL_HTML);
    else insertHtml(TWO_COL_HTML);
  }

  function insertThreeCol() {
    if (contentFormat === "markdown") mdInsertBlock(THREE_COL_HTML);
    else insertHtml(THREE_COL_HTML);
  }

  // Tag management
  async function handleTagInput(value: string) {
    setTagInput(value);
    if (value.length >= 2) {
      try {
        const result = await searchTags(value);
        setTagSuggestions(result.tags.filter((t) => !tags.includes(t)));
        setShowTagSuggestions(result.tags.length > 0);
      } catch {
        setTagSuggestions([]);
      }
    } else {
      setShowTagSuggestions(false);
    }
  }

  function addTag(tag: string) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setValue("tags", [...tags, trimmed]);
    }
    setTagInput("");
    setShowTagSuggestions(false);
  }

  function removeTag(tag: string) {
    setValue(
      "tags",
      tags.filter((t) => t !== tag)
    );
  }

  function handleTagKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (tagInput.trim()) addTag(tagInput);
    } else if (e.key === "Escape") {
      setShowTagSuggestions(false);
    }
  }

  // Image upload
  async function handleImageUpload() {
    if (!imageFile) return;
    setImageUploading(true);
    try {
      const result = await uploadImage(imageFile, imageAlt);
      if (result.success) {
        const alt = imageAlt || result.file.title;
        if (contentFormat === "markdown") {
          mdInsertBlock(`![${alt}](${result.file.url})`);
        } else {
          insertHtml(`<img src="${result.file.url}" alt="${alt}" style="max-width:100%;height:auto;" />`);
        }
        setImageDialogOpen(false);
        setImageFile(null);
        setImageAlt("");
        toast.success("Image inserted");
      }
    } catch {
      toast.error("Failed to upload image");
    } finally {
      setImageUploading(false);
    }
  }

  // Free title-card featured image (rendered server-side, no external API).
  // Only for a saved post: the endpoint writes the image onto the post itself.
  async function handleGenerateImage() {
    if (!post?.id) return;
    setGeneratingImage(true);
    try {
      const result = await generateFeaturedImage(post.id);
      setValue("featured_image", result.featured_image, { shouldDirty: true });
      if (result.featured_image_alt && !watch("featured_image_alt")) {
        setValue("featured_image_alt", result.featured_image_alt, { shouldDirty: true });
      }
      toast.success("Featured image generated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate a featured image");
    } finally {
      setGeneratingImage(false);
    }
  }

  // SEO generation (G#35): draft into the Suggestions panel — NEVER straight
  // into the form. Each field is applied only when the writer clicks its own
  // "Use" button below (see the panel in the SEO section), so an LLM
  // hallucination or a bad heuristic guess is always reviewable, editable and
  // rejectable before it touches the post.
  async function handleGenerateSeo() {
    const content = contentFormat === "markdown" ? watch("content") ?? "" : editorRef.current?.innerHTML ?? "";
    if (!title) {
      toast.error("Please enter a title first");
      return;
    }
    setGeneratingSeo(true);
    try {
      const result = await generateSeo(title, content);
      if (result.success) {
        setSeoSuggestions(result.data);
        toast.success(
          result.data.source === "llm" ? "SEO suggestions ready — review below" : "SEO suggestions ready (heuristic fallback — AI isn't configured)"
        );
      }
    } catch {
      toast.error("Failed to generate SEO suggestions");
    } finally {
      setGeneratingSeo(false);
    }
  }

  /** Apply one suggested field to the form — the only place setValue runs for an AI/heuristic suggestion. */
  function acceptSeoSuggestion(field: "seo_title" | "meta_description" | "excerpt" | "meta_keywords" | "featured_image_alt" | "answer_summary") {
    const value = seoSuggestions?.[field];
    if (!value) return;
    setValue(field, value, { shouldDirty: true });
    toast.success(`Applied ${field.replace(/_/g, " ")}`);
  }

  // Category management
  async function handleAddCategory() {
    if (!newCatName.trim()) return;
    setAddingCat(true);
    try {
      const cat = await createCategory({
        name: newCatName.trim(),
        slug: generateSlug(newCatName.trim()),
      });
      toast.success(`Category "${cat.name}" created`);
      setValue("category_id", cat.id);
      setNewCatName("");
      setShowCatInput(false);
      refetchCategories();
    } catch {
      toast.error("Failed to create category");
    } finally {
      setAddingCat(false);
    }
  }

  function applyRevision(revision: BlogRevision, styleProfileId: string | null) {
    setValue("title", revision.title);
    setValue("excerpt", revision.excerpt);
    setValue("meta_description", revision.meta_description);
    setValue("meta_keywords", revision.meta_keywords);
    if (revision.tags.length > 0) setValue("tags", revision.tags);
    if (editorRef.current) editorRef.current.innerHTML = revision.content_html;
    setAiSnapshot(
      styleProfileId ? { profile_id: styleProfileId, content: revision.content_html } : null
    );
  }

  function applyRestoredPost(restored: Post) {
    setValue("title", restored.title, { shouldDirty: true });
    setValue("excerpt", restored.excerpt ?? "", { shouldDirty: true });
    if (restored.content_format === "markdown") {
      setValue("content", restored.content ?? "", { shouldDirty: true });
    } else if (editorRef.current) {
      editorRef.current.innerHTML = restored.content_html ?? restored.content ?? "";
    }
    setContentFormat(restored.content_format === "html" ? "html" : "markdown");
    // The server already wrote target.content_hash — without this, the next
    // save sends the pre-restore hash and 409s against the restore the user
    // themselves just performed.
    setContentHash(restored.content_hash);
  }

  const onSubmit = handleSubmit((data) => saveMutation.mutate(data));

  const isSaving = saveMutation.isPending;
  const isPublishing = publishMutation.isPending;

  return (
    <form onSubmit={onSubmit} className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-background px-6 py-3 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => router.push("/posts")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-base font-semibold">
              {post ? "Edit Post" : "New Post"}
            </h1>
            {post && (
              <p className="text-xs text-muted-foreground">/{post.slug}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => router.push("/posts")}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setValue("status", "archived");
              handleSubmit((data) =>
                saveMutation.mutate({ ...data, status: "archived" })
              )();
            }}
          >
            <Archive className="h-4 w-4 mr-2" />
            Archive
          </Button>
          {/* AI polish always outputs HTML today — out of scope for markdown
              posts until the style engine is markdown-aware (Phase 0 note
              in FILE-BASED-CONTENT-PLAN.md). */}
          {post?.id && contentFormat === "html" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFinalizeOpen(true)}
              title="Polish the saved draft in your writing style"
            >
              <Sparkles className="h-4 w-4 mr-2" />
              Finalize with AI
            </Button>
          )}
          {post?.id && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFanoutOpen(true)}
              title="Generate per-network social drafts from the saved post"
            >
              <Share2 className="h-4 w-4 mr-2" />
              Social drafts
            </Button>
          )}
          {post?.id && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              title="View and restore past revisions of this post"
            >
              <History className="h-4 w-4 mr-2" />
              History
            </Button>
          )}
          {post?.id && can("content:edit") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPreviewDialogOpen(true)}
              title="Get a link a reviewer can open without signing in"
            >
              <Eye className="h-4 w-4 mr-2" />
              Preview link
            </Button>
          )}
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={isSaving}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Draft
          </Button>
          {can("content:publish") ? (
            currentStatus === "published" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => unpublishMutation.mutate()}
                disabled={unpublishMutation.isPending}
              >
                Unpublish
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => publishMutation.mutate()}
                disabled={isPublishing}
              >
                {isPublishing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Globe className="h-4 w-4 mr-2" />
                )}
                Publish
              </Button>
            )
          ) : (
            currentStatus !== "published" &&
            (!post || ["draft", "rejected"].includes(post.workflow_status)) && (
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  handleSubmit((data) => submitReviewMutation.mutate(data))()
                }
                disabled={submitReviewMutation.isPending}
              >
                {submitReviewMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Submit for review
              </Button>
            )
          )}
        </div>
      </div>

      {finalizeOpen && post?.id && (
        <AiFinalizeDialog
          postId={post.id}
          currentTitle={title}
          currentHtml={editorRef.current?.innerHTML ?? post.content ?? ""}
          onApply={applyRevision}
          onClose={() => setFinalizeOpen(false)}
        />
      )}

      {fanoutOpen && post?.id && (
        <AiSocialFanoutDialog postId={post.id} onClose={() => setFanoutOpen(false)} />
      )}

      {historyOpen && post?.id && (
        <PostHistoryDialog
          postId={post.id}
          contentHash={contentHash}
          currentContent={
            contentFormat === "markdown" ? watch("content") ?? "" : editorRef.current?.innerHTML ?? ""
          }
          onRestore={applyRestoredPost}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preview link</DialogTitle>
          </DialogHeader>
          {previewUrl ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Anyone with this link can view the current draft without signing in. It
                expires automatically and can be revoked at any time.
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly value={previewUrl} onFocus={(e) => e.target.select()} />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={async () => {
                    await navigator.clipboard.writeText(previewUrl);
                    toast.success("Link copied");
                  }}
                  title="Copy link"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No preview link is active for this post yet.
            </p>
          )}
          <DialogFooter>
            {previewUrl && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => revokePreviewLinkMutation.mutate()}
                disabled={revokePreviewLinkMutation.isPending}
              >
                Revoke link
              </Button>
            )}
            <Button
              type="button"
              onClick={() => createPreviewLinkMutation.mutate()}
              disabled={createPreviewLinkMutation.isPending}
            >
              {createPreviewLinkMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              {previewUrl ? "Generate a new link" : "Generate link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rejection notice */}
      {post?.workflow_status === "rejected" && post.rejection_reason && (
        <div className="border-b bg-destructive/10 px-6 py-2.5">
          <p className="text-sm text-destructive">
            <span className="font-medium">Changes requested:</span> {post.rejection_reason}
          </p>
        </div>
      )}
      {post?.workflow_status === "pending_review" && (
        <div className="border-b bg-blue-50 px-6 py-2.5">
          <p className="text-sm text-blue-800">This post is awaiting review.</p>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Main content area (2/3) */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Title */}
          <div className="space-y-1">
            <Input
              placeholder="Post title..."
              className="text-2xl font-bold border-none shadow-none px-0 placeholder:text-muted-foreground/50 focus-visible:ring-0 h-auto py-1"
              {...register("title")}
            />
            {errors.title && (
              <p className="text-xs text-destructive">{errors.title.message}</p>
            )}
          </div>

          {/* Slug */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">URL:</span>
            <Input
              placeholder="url-slug"
              className="h-8 text-sm font-mono max-w-sm"
              {...register("slug")}
              onChange={(e) => {
                setSlugManuallyEdited(true);
                setValue("slug", generateSlug(e.target.value));
              }}
            />
            {errors.slug && (
              <p className="text-xs text-destructive">{errors.slug.message}</p>
            )}
          </div>

          {/* Content Editor */}
          <div className="rounded-lg border bg-background overflow-hidden">
            {/* Format */}
            <div className="flex items-center justify-between border-b px-3 py-2">
              <Label className="text-xs text-muted-foreground">Content format</Label>
              {post ? (
                <span className="text-xs font-medium capitalize">{contentFormat}</span>
              ) : (
                <Select
                  value={contentFormat}
                  onValueChange={(v) => setContentFormat(v as "markdown" | "html")}
                >
                  <SelectTrigger className="h-7 w-40 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="markdown">Markdown</SelectItem>
                    <SelectItem value="html">Rich text (HTML)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            {contentFormat === "markdown" ? (
              // Markdown posts: the formatted editor shared with the writer
              // editor (/write). Only the writer's edits reach the form.
              <MarkdownContentEditor
                ref={mdEditorRef}
                value={watch("content") ?? ""}
                onChange={(md) => setValue("content", md, { shouldDirty: true })}
                upload={async (file) => {
                  const alt = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
                  const result = await uploadImage(file, alt);
                  if (!result.success) throw new Error("Couldn't upload the image.");
                  return { url: result.file.url, alt: result.file.title || alt };
                }}
                onError={(message) => toast.error(message)}
                extra={[
                  { label: "Add Image", icon: <ImageIcon className="h-4 w-4" />, onClick: () => setImageDialogOpen(true) },
                  { label: "YouTube", icon: <SquarePlay className="h-4 w-4" />, onClick: insertYoutube },
                  { label: "2 Column Layout", icon: <Columns2 className="h-4 w-4" />, text: "2 Col", onClick: insertTwoCol },
                  { label: "3 Column Layout", icon: <Columns3 className="h-4 w-4" />, text: "3 Col", onClick: insertThreeCol },
                ]}
              />
            ) : (
              <>
            {/* Toolbar */}
            <div className="flex items-center gap-1 border-b px-3 py-2 bg-muted/30 flex-wrap">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={insertBold}
                title="Bold"
              >
                <Bold className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={insertItalic}
                title="Italic"
              >
                <Italic className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={insertHeading}
                title="Heading"
              >
                <Heading2 className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={insertList}
                title="List"
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={insertLink}
                title="Link"
              >
                <Link2 className="h-4 w-4" />
              </Button>
              <div className="w-px h-5 bg-border mx-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setImageDialogOpen(true)}
                title="Add Image"
              >
                <ImageIcon className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={insertYoutube}
                title="YouTube"
              >
                <SquarePlay className="h-4 w-4" />
              </Button>
              <div className="w-px h-5 bg-border mx-1" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={insertTwoCol}
                title="2 Column Layout"
              >
                <Columns2 className="h-4 w-4" />
                2 Col
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={insertThreeCol}
                title="3 Column Layout"
              >
                <Columns3 className="h-4 w-4" />
                3 Col
              </Button>
            </div>

            {/* Content Tabs */}
            <Tabs defaultValue="write">
              <TabsList className="mx-3 mt-2 mb-0 bg-transparent border-b rounded-none w-auto p-0 h-auto gap-1">
                <TabsTrigger
                  value="write"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent pb-2"
                >
                  Write
                </TabsTrigger>
                <TabsTrigger
                  value="preview"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent pb-2"
                >
                  Preview
                </TabsTrigger>
              </TabsList>
              <TabsContent value="write" className="m-0">
                  <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="content-editor min-h-[400px] p-4 outline-none focus:outline-none text-sm leading-relaxed"
                    data-placeholder="Start writing your post..."
                    style={
                      {
                        "--placeholder-color": "hsl(var(--muted-foreground) / 0.5)",
                      } as React.CSSProperties
                    }
                  />
              </TabsContent>
              <TabsContent value="preview" className="m-0">
                <div
                  className="prose-preview min-h-[400px] p-4 text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{
                    __html: editorRef.current?.innerHTML ?? post?.content ?? "",
                  }}
                />
              </TabsContent>
            </Tabs>
              </>
            )}
          </div>

          {/* SEO Section */}
          <div className="rounded-lg border bg-background p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">SEO Settings</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={handleGenerateSeo}
                disabled={generatingSeo}
              >
                {generatingSeo ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate SEO Content
              </Button>
            </div>

            {/* AI SEO suggestions (G#35): a distinct review panel — every
                field below is a DRAFT until its own "Use" button is clicked.
                Nothing here is ever written to the post automatically. */}
            {seoSuggestions && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" />
                    Suggestions
                  </h4>
                  <div className="flex items-center gap-2">
                    <Badge variant={seoSuggestions.source === "llm" ? "default" : "secondary"} className="text-[10px]">
                      {seoSuggestions.source === "llm" ? "AI draft" : "Heuristic (AI not configured)"}
                    </Badge>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setSeoSuggestions(null)}>
                      Dismiss
                    </Button>
                  </div>
                </div>

                {(
                  [
                    { field: "seo_title" as const, label: "SEO title", value: seoSuggestions.seo_title },
                    { field: "meta_description" as const, label: "Meta description", value: seoSuggestions.meta_description },
                    { field: "excerpt" as const, label: "Excerpt", value: seoSuggestions.excerpt },
                    { field: "meta_keywords" as const, label: "Meta keywords", value: seoSuggestions.meta_keywords },
                    { field: "featured_image_alt" as const, label: "Featured image alt", value: seoSuggestions.featured_image_alt },
                    { field: "answer_summary" as const, label: "Answer summary (TL;DR)", value: seoSuggestions.answer_summary },
                  ] satisfies { field: "seo_title" | "meta_description" | "excerpt" | "meta_keywords" | "featured_image_alt" | "answer_summary"; label: string; value: string | null }[]
                ).map(({ field, label, value }) =>
                  value ? (
                    <div key={field} className="flex items-start justify-between gap-2 rounded-md border bg-background p-2">
                      <div className="space-y-0.5">
                        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
                        <p className="text-xs">{value}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[11px]"
                        onClick={() => acceptSeoSuggestion(field)}
                      >
                        Use
                      </Button>
                    </div>
                  ) : null
                )}

                {seoSuggestions.question_headings.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Question-phrased headings to consider adding — copy into the body yourself:
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {seoSuggestions.question_headings.map((h, i) => (
                        <li key={i} className="text-[11px]">{h}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {seoSuggestions.citations_needed.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Claims that could use a source link:
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {seoSuggestions.citations_needed.map((c, i) => (
                        <li key={i} className="text-[11px]">&ldquo;{c}&rdquo;</li>
                      ))}
                    </ul>
                  </div>
                )}

                {seoSuggestions.faq.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Suggested FAQ — add to the body if these are genuine reader questions:
                    </p>
                    <ul className="space-y-1">
                      {seoSuggestions.faq.map((item, i) => (
                        <li key={i} className="text-[11px]">
                          <span className="font-medium">{item.question}</span> {item.answer}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Excerpt</Label>
                <Textarea
                  placeholder="Brief description of the post..."
                  className="text-sm resize-none"
                  rows={2}
                  {...register("excerpt")}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Meta Description</Label>
                <Textarea
                  placeholder="SEO meta description..."
                  className="text-sm resize-none"
                  rows={2}
                  {...register("meta_description")}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Meta Keywords</Label>
                <Input
                  placeholder="keyword1, keyword2..."
                  className="text-sm"
                  {...register("meta_keywords")}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Featured Image Alt</Label>
                <Input
                  placeholder="Image description..."
                  className="text-sm"
                  {...register("featured_image_alt")}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Featured Image URL</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={handleGenerateImage}
                    disabled={!post?.id || generatingImage}
                    title={post?.id ? "Render a title card from the post title" : "Save the post first"}
                  >
                    {generatingImage ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImageIcon className="h-3.5 w-3.5" />
                    )}
                    {watch("featured_image") ? "Regenerate title card" : "Generate title card"}
                  </Button>
                </div>
                <Input
                  placeholder="https://..."
                  className="text-sm"
                  {...register("featured_image")}
                />
                <p className="text-[11px] text-muted-foreground">
                  Leave empty and a free title card is generated when the post is published.
                </p>
                {watch("featured_image") && (
                  <img
                    src={watch("featured_image")}
                    alt={watch("featured_image_alt") || "Featured image preview"}
                    className="mt-2 w-full max-w-sm rounded-md border"
                  />
                )}
              </div>
            </div>

            {/* Search & AI readiness overrides (G#31) */}
            <div className="grid grid-cols-2 gap-4 pt-2 border-t">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">SEO Title</Label>
                <Input
                  placeholder="Overrides the title in <title>, og:title and twitter:title — leave empty to use the post title"
                  className="text-sm"
                  {...register("seo_title")}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Canonical URL</Label>
                <Input
                  placeholder="Only for a syndicated copy published elsewhere first"
                  className="text-sm"
                  {...register("canonical_url")}
                />
              </div>
              <div className="flex items-center pt-5">
                <label className="flex min-h-11 items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={watch("noindex")}
                    onCheckedChange={(value) => setValue("noindex", !!value)}
                  />
                  Hide from search engines (noindex)
                </label>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Social Image URL</Label>
                <Input
                  placeholder="Falls back to the featured image"
                  className="text-sm"
                  {...register("og_image")}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Social Image Alt</Label>
                <Input className="text-sm" {...register("og_image_alt")} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Answer Summary (TL;DR, 40-60 words)</Label>
                <Textarea
                  placeholder="A short, self-contained answer to this post's question — the source for a TL;DR block and AI answer engines"
                  className="text-sm resize-none"
                  rows={2}
                  {...register("answer_summary")}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Redirect To</Label>
                <Input
                  placeholder="/post/other-slug or https://... — leave empty unless this post has been superseded"
                  className="text-sm"
                  {...register("redirect_to")}
                />
              </div>
              <div className="col-span-2 rounded-md border p-2 space-y-1">
                <label className="flex min-h-11 items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={watch("mark_updated")}
                    onCheckedChange={(value) => setValue("mark_updated", !!value)}
                  />
                  Mark as updated on this save
                </label>
                <p className="text-[11px] text-muted-foreground pl-6">
                  {post?.content_updated_at
                    ? `Last substantive update: ${new Date(post.content_updated_at).toLocaleString()}. A save that only changes title/content/excerpt updates this automatically — check the box only for an edit this can't see (e.g. correcting a figure).`
                    : "Not yet substantively updated. A save that changes title/content/excerpt sets this automatically."}
                </p>
              </div>
            </div>

            {/* Search & AI readiness (G#32) */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold">Search & AI readiness</h4>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => refetchReadiness()}
                  disabled={!post?.id || checkingReadiness}
                  title={post?.id ? "Check the last saved version" : "Save the post first"}
                >
                  {checkingReadiness && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                  Check readiness
                </Button>
              </div>
              {!post?.id && (
                <p className="text-[11px] text-muted-foreground">Save the post first — this checks the last saved version.</p>
              )}
              {readiness && (
                <div className="space-y-2">
                  {readiness.errors.length === 0 ? (
                    <p className="text-[11px] text-emerald-600">No errors — publish/approve would not be blocked.</p>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-destructive">
                        {readiness.errors.length} error(s) — publish/approve is blocked until these clear:
                      </p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {readiness.errors.map((f) => (
                          <li key={f.key} className="text-[11px] text-destructive">{f.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {readiness.warnings.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {readiness.warnings.length} advisory warning(s):
                      </p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {readiness.warnings.map((f) => (
                          <li key={f.key} className="text-[11px] text-muted-foreground">{f.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Social: copy per network, where it goes, and the link back */}
          <div className="rounded-lg border bg-background p-4 space-y-3">
            <h3 className="font-semibold text-sm">Social</h3>
            {post?.id ? (
              <PostSocialPanel
                draftsUrl={`/api/cms/posts/${post.id}/social`}
                placesUrl={`/api/cms/posts/${post.id}/social/destinations`}
                readOnly={!can("content:edit")}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Save the post first. Its social copy and where it goes are kept with the saved post.
              </p>
            )}
          </div>
        </div>

        {/* Sidebar (1/3) */}
        <div className="w-80 border-l overflow-y-auto p-4 space-y-4 bg-background shrink-0">
          {/* Publish Settings */}
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="font-semibold text-sm">Publish Settings</h3>
            <div className="space-y-1">
              <Label className="text-xs">Published Date</Label>
              <Input
                type="datetime-local"
                className="text-sm"
                {...register("published_at")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Author</Label>
              <Input
                placeholder="Author name..."
                className="text-sm"
                disabled={!can("content:edit_any")}
                {...register("author_name")}
              />
              {!can("content:edit_any") && (
                <p className="text-xs text-muted-foreground">
                  Only someone with content:edit_any can change who a post is credited to.
                </p>
              )}
            </div>
          </div>

          {/* Platforms */}
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="font-semibold text-sm">Publish To</h3>
            <Controller
              name="platforms"
              control={control}
              render={({ field }) => (
                <div className="space-y-2">
                  {sites.map((site) => {
                    const selected = field.value ?? [];
                    const checked = selected.includes(site.slug);
                    return (
                      <label
                        key={site.slug}
                        className="flex min-h-11 items-center gap-2 text-sm cursor-pointer"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) =>
                            field.onChange(
                              value
                                ? [...selected, site.slug]
                                : selected.filter((p) => p !== site.slug)
                            )
                          }
                        />
                        {site.name}
                      </label>
                    );
                  })}
                  {sites.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Loading sites…
                    </p>
                  )}
                </div>
              )}
            />
            {errors.platforms && (
              <p className="text-xs text-destructive">
                {errors.platforms.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Which sites show this post once published
            </p>
          </div>

          {/* Content Type — an OPEN combobox, not a fixed Select (G#19).
              A native datalist keeps this one plain input: it suggests the
              org's registered types while still accepting a new one typed in
              place, works with the keyboard and on touch, and needs no new
              component. */}
          <div className="rounded-lg border p-4 space-y-3">
            <Label htmlFor="post-type" className="font-semibold text-sm">
              Content Type
            </Label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <>
                  <Input
                    id="post-type"
                    list="post-type-options"
                    className="text-sm"
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value)}
                    placeholder="blog"
                    aria-describedby="post-type-hint"
                  />
                  <datalist id="post-type-options">
                    {contentTypes.map((t) => (
                      <option key={t.slug} value={t.slug}>
                        {t.name}
                      </option>
                    ))}
                  </datalist>
                </>
              )}
            />
            <p id="post-type-hint" className="text-xs text-muted-foreground">
              Pick one or type a new one — lowercase words joined by hyphens.
            </p>
            {errors.type && (
              <p className="text-xs text-destructive">{errors.type.message}</p>
            )}
          </div>

          {/* Category */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">Category</h3>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setShowCatInput(!showCatInput)}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>

            <Controller
              name="category_id"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value || "none"}
                  onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue placeholder="No category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No category</SelectItem>
                    {categories.map((cat) => (
                      <SelectItem key={cat.id} value={cat.id}>
                        <div className="flex items-center gap-2">
                          {cat.color && (
                            <span
                              className="h-3 w-3 rounded-full shrink-0"
                              style={{ backgroundColor: cat.color }}
                            />
                          )}
                          {cat.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />

            {showCatInput && (
              <div className="flex gap-2">
                <Input
                  placeholder="Category name..."
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  className="text-sm h-8 flex-1"
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddCategory())}
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  onClick={handleAddCategory}
                  disabled={addingCat}
                >
                  {addingCat ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* Tags */}
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="font-semibold text-sm">Tags</h3>

            {/* Tag chips */}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="gap-1 pr-1 text-xs"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="hover:text-destructive ml-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            {/* Tag input */}
            <div className="relative">
              <Input
                placeholder="Add tag..."
                value={tagInput}
                onChange={(e) => handleTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                className="text-sm h-8"
              />
              {showTagSuggestions && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-md border bg-popover shadow-md">
                  {tagSuggestions.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent"
                      onClick={() => addTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                  {tagInput && !tagSuggestions.includes(tagInput) && (
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent text-muted-foreground"
                      onClick={() => addTag(tagInput)}
                    >
                      Create &ldquo;{tagInput}&rdquo;
                    </button>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Press Enter or comma to add a tag
            </p>
          </div>
        </div>
      </div>

      {/* Image Upload Dialog */}
      <Dialog open={imageDialogOpen} onOpenChange={setImageDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Insert Image</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Image File</Label>
              <Input
                type="file"
                accept="image/*"
                onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-2">
              <Label>Alt Text</Label>
              <Input
                placeholder="Describe the image..."
                value={imageAlt}
                onChange={(e) => setImageAlt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImageDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleImageUpload}
              disabled={!imageFile || imageUploading}
            >
              {imageUploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Insert Image
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
