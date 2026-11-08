"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Upload,
  FileText,
  X,
  Image as ImageIcon,
  ArrowLeft,
  Loader2,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  createPost,
  importPostFile,
  listCategories,
  listContentTypes,
  listSites,
  uploadMedia,
} from "@/lib/api";
import { generateSlug, formatFileSize } from "@/lib/utils";
import { DEFAULT_SITE_SLUGS } from "@/lib/sites";
import { useMe } from "@/hooks/use-me";

interface UploadedImage {
  file: File;
  preview: string;
  isFeatured: boolean;
}

export default function UploadPostPage() {
  const router = useRouter();
  const { can } = useMe();
  const [contentFile, setContentFile] = useState<File | null>(null);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [authorName, setAuthorName] = useState("");
  const [postType, setPostType] = useState<string>("blog");
  const [categoryId, setCategoryId] = useState<string>("");
  const [platforms, setPlatforms] = useState<string[]>([...DEFAULT_SITE_SLUGS]);
  const [parsedTitle, setParsedTitle] = useState("");
  const [parsedContent, setParsedContent] = useState("");
  const [parsedStyles, setParsedStyles] = useState("");
  const [contentFormat, setContentFormat] = useState("html");
  // Set when the dropped .md file has YAML frontmatter (see
  // FILE-BASED-CONTENT-PLAN.md Phase 1) — the file becomes the source of
  // truth for all metadata (title, SEO fields, status, etc.), imported via
  // /api/cms/posts/import instead of the legacy H1-only parse below.
  const [frontmatterRaw, setFrontmatterRaw] = useState<string | null>(null);
  const [frontmatterSlugPreview, setFrontmatterSlugPreview] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: listCategories,
  });

  // Suggestions only — the type field accepts a value absent from this list.
  const { data: contentTypes = [] } = useQuery({
    queryKey: ["content-types"],
    queryFn: listContentTypes,
  });

  // This org's distribution targets (G#18) — no longer a compile-time list.
  const { data: sites = [] } = useQuery({
    queryKey: ["sites"],
    queryFn: listSites,
  });

  const createMutation = useMutation({
    mutationFn: createPost,
    onSuccess: (post) => {
      toast.success("Post created from upload");
      router.push(`/posts/${post.slug}/edit`);
    },
    onError: () => toast.error("Failed to create post"),
  });

  // Content file dropzone
  const onContentDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    setContentFile(file);
    const text = await file.text();
    const isMarkdown = file.name.endsWith(".md") || file.name.endsWith(".markdown");

    // A .md file with YAML frontmatter is a full export from this CMS (or
    // hand-authored to match it) — every field, SEO metadata included,
    // comes from the file itself. Hand off to the frontmatter importer
    // rather than the legacy H1-only parse below.
    if (isMarkdown && /^---\r?\n/.test(text)) {
      setFrontmatterRaw(text);
      // Preview only — the server re-parses and validates the real
      // frontmatter on import; this is just a friendly display of it.
      const titleMatch = text.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      const slugMatch = text.match(/^slug:\s*["']?(.+?)["']?\s*$/m);
      const title = titleMatch?.[1] ?? file.name.replace(/\.mdx?$/i, "");
      setParsedTitle(title);
      setFrontmatterSlugPreview(slugMatch?.[1] ?? generateSlug(title));
      setIsPreviewing(true);
      return;
    }

    setFrontmatterRaw(null);

    // Parse title from content
    let title = file.name.replace(/\.(html|md|markdown)$/i, "").replace(/-/g, " ");
    let content = text;
    let styles = "";
    let format = "html";

    if (isMarkdown) {
      // Extract first H1 as title; the body is stored as real markdown now
      // (see FILE-BASED-CONTENT-PLAN.md D2) and rendered server-side.
      const h1Match = text.match(/^#\s+(.+)$/m);
      if (h1Match) {
        title = h1Match[1];
        content = text.replace(/^#\s+.+\n?/, "").trim();
      }
      format = "markdown";
    } else {
      // HTML: try to find title tag
      const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      const h1Match = text.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (titleMatch) title = titleMatch[1];
      else if (h1Match) title = h1Match[1];

      // Extract <style> blocks — stored separately as content_styles; the
      // website scopes and injects them when rendering the post.
      const styleBlocks = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
      styles = styleBlocks.map((m) => m[1].trim()).join("\n\n");

      // Extract body content
      const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (bodyMatch) content = bodyMatch[1];
      content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").trim();
    }

    setParsedTitle(title);
    setParsedContent(content);
    setParsedStyles(styles);
    setContentFormat(format);
    setIsPreviewing(true);
  }, []);

  const { getRootProps: getContentProps, getInputProps: getContentInput, isDragActive: isContentDragActive } =
    useDropzone({
      onDrop: onContentDrop,
      accept: {
        "text/html": [".html", ".htm"],
        "text/markdown": [".md", ".markdown"],
        "text/plain": [".txt"],
      },
      maxFiles: 1,
      maxSize: 10 * 1024 * 1024, // 10MB
    });

  // Image dropzone
  const onImagesDrop = useCallback((acceptedFiles: File[]) => {
    const newImages = acceptedFiles.slice(0, 50 - images.length).map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      isFeatured: images.length === 0, // First image is featured by default
    }));
    setImages((prev) => [...prev, ...newImages]);
  }, [images]);

  const { getRootProps: getImagesProps, getInputProps: getImagesInput, isDragActive: isImagesDragActive } =
    useDropzone({
      onDrop: onImagesDrop,
      accept: { "image/*": [".jpg", ".jpeg", ".png", ".gif", ".webp"] },
      maxFiles: 50,
    });

  function removeImage(index: number) {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      // If we removed the featured image, make first one featured
      if (prev[index].isFeatured && next.length > 0) {
        next[0].isFeatured = true;
      }
      return next;
    });
  }

  function setFeaturedImage(index: number) {
    setImages((prev) =>
      prev.map((img, i) => ({ ...img, isFeatured: i === index }))
    );
  }

  async function handleCreate() {
    if (!contentFile || (!frontmatterRaw && !parsedContent)) {
      toast.error("Please upload a content file first");
      return;
    }

    setIsUploading(true);
    try {
      if (frontmatterRaw) {
        // Frontmatter mode: the file is the source of truth for every
        // field, so images just need their local filenames rewritten to
        // uploaded URLs (covers in-body images and a local featured_image
        // reference alike) — everything else is handled server-side.
        let raw = frontmatterRaw;
        for (const image of images) {
          const media = await uploadMedia(image.file);
          raw = raw.split(image.file.name).join(media.file_path);
        }
        const result = await importPostFile({ raw, filename: contentFile.name });
        if (result.warning) toast.warning(result.warning);
        toast.success(result.created ? "Post created from file" : "Post updated from file");
        router.push(`/posts/${result.data.slug}/edit`);
        return;
      }

      if (platforms.length === 0) {
        toast.error("Select at least one platform");
        return;
      }

      // Upload every dropped image for real (blob preview URLs die with the
      // page), then rewrite references to the original filenames in the
      // content to the stored URLs.
      let content = parsedContent;
      let featuredUrl = "";
      for (const image of images) {
        const media = await uploadMedia(image.file);
        content = content.split(image.file.name).join(media.file_path);
        if (image.isFeatured) featuredUrl = media.file_path;
      }

      await createMutation.mutateAsync({
        title: parsedTitle,
        slug: generateSlug(parsedTitle),
        content,
        content_format: contentFormat,
        content_styles: parsedStyles,
        excerpt: "",
        status: "draft",
        type: postType,
        featured_image: featuredUrl,
        featured_image_alt: featuredUrl ? parsedTitle : "",
        meta_description: "",
        meta_keywords: "",
        author_name: authorName,
        published_at: "",
        tags: [],
        platforms,
        category_id: categoryId,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed — post not created");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl animate-fade-in">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/posts")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Upload Post</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Import an HTML or Markdown file — a Markdown file with frontmatter
            (exported from this CMS, or written to match) syncs as a full post,
            including SEO fields
          </p>
        </div>
      </div>

      {/* Content file drop */}
      <div className="space-y-2">
        <Label>Content File</Label>
        <div
          {...getContentProps()}
          className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
            isContentDragActive
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50"
          }`}
        >
          <input {...getContentInput()} />
          <FileText className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          {contentFile ? (
            <div className="space-y-1">
              <p className="font-medium text-sm">{contentFile.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(contentFile.size)}
              </p>
              <Badge variant="success" className="text-xs">Ready</Badge>
            </div>
          ) : (
            <>
              <p className="font-medium text-sm">Drop your file here</p>
              <p className="text-xs text-muted-foreground mt-1">
                HTML, Markdown, or text files — max 10MB
              </p>
            </>
          )}
        </div>
      </div>

      {/* Parsed preview */}
      {isPreviewing && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="p-4 space-y-2">
            <p className="text-xs font-semibold text-green-700 uppercase tracking-wider">
              {frontmatterRaw ? "Frontmatter detected" : "Parsed Metadata"}
            </p>
            <div className="space-y-1">
              <p className="text-sm">
                <span className="font-medium">Title: </span>
                {parsedTitle}
              </p>
              <p className="text-sm">
                <span className="font-medium">Slug: </span>
                <span className="font-mono text-xs">
                  {frontmatterRaw ? frontmatterSlugPreview : generateSlug(parsedTitle)}
                </span>
              </p>
              {frontmatterRaw ? (
                <p className="text-sm text-muted-foreground text-xs">
                  All metadata — status, SEO fields, category, tags — comes from the
                  file&apos;s frontmatter. The fields below are ignored.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground text-xs">
                  {parsedContent.slice(0, 150).replace(/<[^>]+>/g, "")}...
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Image upload */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Images (optional, max 50)</Label>
          <span className="text-xs text-muted-foreground">
            {images.length} / 50 images
          </span>
        </div>

        <div
          {...getImagesProps()}
          className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
            isImagesDragActive
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50"
          }`}
        >
          <input {...getImagesInput()} />
          <ImageIcon className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium">Drop images here</p>
          <p className="text-xs text-muted-foreground">JPEG, PNG, GIF, WebP</p>
        </div>

        {images.length > 0 && (
          <div className="grid grid-cols-4 gap-3">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                {/* Image preview — src is a local object URL, Next.js Image not needed */}
                <img
                  src={img.preview}
                  alt={`Upload ${i + 1}`}
                  className="w-full h-24 object-cover rounded-lg border"
                />
                {img.isFeatured && (
                  <Badge
                    variant="success"
                    className="absolute top-1 left-1 text-xs py-0"
                  >
                    <Star className="h-3 w-3 mr-1" />
                    Featured
                  </Badge>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-1">
                  {!img.isFeatured && (
                    <Button
                      type="button"
                      size="icon"
                      className="h-7 w-7 bg-white text-black hover:bg-white/90"
                      onClick={() => setFeaturedImage(i)}
                      title="Set as featured"
                    >
                      <Star className="h-3 w-3" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    className="h-7 w-7"
                    onClick={() => removeImage(i)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Metadata — ignored in frontmatter mode, where the file is authoritative */}
      <div
        className={`grid grid-cols-2 gap-4 ${frontmatterRaw ? "opacity-40 pointer-events-none" : ""}`}
        aria-disabled={!!frontmatterRaw}
      >
        <div className="space-y-2">
          <Label>Author</Label>
          <Input
            placeholder="Author name..."
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            disabled={!can("content:edit_any")}
          />
          {!can("content:edit_any") && (
            <p className="text-xs text-muted-foreground">
              Only someone with content:edit_any can change who a post is credited to.
            </p>
          )}
        </div>
        {/* Open combobox, matching the post editor (G#19) — a datalist
            suggests the org's registered types while still accepting a new
            one typed in place. */}
        <div className="space-y-2">
          <Label htmlFor="upload-post-type">Content Type</Label>
          <Input
            id="upload-post-type"
            list="upload-post-type-options"
            value={postType}
            onChange={(e) => setPostType(e.target.value)}
            placeholder="blog"
            aria-describedby="upload-post-type-hint"
          />
          <datalist id="upload-post-type-options">
            {contentTypes.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </datalist>
          <p id="upload-post-type-hint" className="text-xs text-muted-foreground">
            Pick one or type a new one — lowercase words joined by hyphens.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Publish To</Label>
          <div className="flex flex-col gap-2 pt-1">
            {sites.map((site) => (
              <label
                key={site.slug}
                className="flex min-h-11 items-center gap-2 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={platforms.includes(site.slug)}
                  onCheckedChange={(value) =>
                    setPlatforms((prev) =>
                      value
                        ? [...prev, site.slug]
                        : prev.filter((p) => p !== site.slug)
                    )
                  }
                />
                {site.name}
              </label>
            ))}
            {sites.length === 0 && (
              <p className="text-xs text-muted-foreground">Loading sites…</p>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <Label>Category</Label>
          <Select value={categoryId || "none"} onValueChange={(v) => setCategoryId(v === "none" ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No category</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button variant="outline" onClick={() => router.push("/posts")}>
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          disabled={!contentFile || isUploading || createMutation.isPending}
        >
          {isUploading || createMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          Create Post
        </Button>
      </div>
    </div>
  );
}
