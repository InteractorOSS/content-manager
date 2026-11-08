"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  Upload,
  Trash2,
  Copy,
  Check,
  Image as ImageIcon,
  Loader2,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { listMedia, uploadMedia, deleteMedia } from "@/lib/api";
import { formatFileSize, formatDate } from "@/lib/utils";
import type { Media } from "@/types/cms";

export function MediaLibrary() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Media | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<Media | null>(null);

  const { data: media = [], isLoading } = useQuery({
    queryKey: ["media"],
    queryFn: listMedia,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMedia(id),
    onSuccess: () => {
      toast.success("Media deleted");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["media"] });
    },
    onError: () => toast.error("Failed to delete media"),
  });

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      setUploading(true);
      try {
        await Promise.all(
          acceptedFiles.map((file) => uploadMedia(file))
        );
        toast.success(
          `${acceptedFiles.length} file${acceptedFiles.length > 1 ? "s" : ""} uploaded`
        );
        queryClient.invalidateQueries({ queryKey: ["media"] });
      } catch {
        toast.error("Some files failed to upload");
      } finally {
        setUploading(false);
      }
    },
    [queryClient]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/*": [], "video/*": [], "application/pdf": [".pdf"] },
  });

  const filtered = media.filter(
    (m) =>
      !search ||
      m.original_filename?.toLowerCase().includes(search.toLowerCase()) ||
      m.alt_text?.toLowerCase().includes(search.toLowerCase())
  );

  const isImage = (m: Media) => m.mime_type.startsWith("image/");

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function copyUrl(m: Media) {
    const url = m.file_path.startsWith("http")
      ? m.file_path
      : m.file_path.startsWith("/")
      ? m.file_path
      : `/${m.file_path}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(m.id);
    toast.success("URL copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  }

  async function handleBulkDelete() {
    try {
      await Promise.all(Array.from(selected).map((id) => deleteMedia(id)));
      toast.success(`Deleted ${selected.size} items`);
      setSelected(new Set());
      setBulkDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch {
      toast.error("Some items failed to delete");
    }
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search media..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Selected ({selected.size})
            </Button>
          )}
        </div>
      </div>

      {/* Upload zone */}
      <div
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
          isDragActive
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50"
        }`}
      >
        <input {...getInputProps()} />
        <div className="flex items-center justify-center gap-3">
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-5 w-5 text-muted-foreground" />
          )}
          <div className="text-left">
            <p className="text-sm font-medium">
              {uploading
                ? "Uploading..."
                : isDragActive
                ? "Drop files here"
                : "Upload files"}
            </p>
            <p className="text-xs text-muted-foreground">
              Images, videos, PDFs — click or drag and drop
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <p className="text-xs text-muted-foreground">
        {filtered.length} items
        {selected.size > 0 && ` · ${selected.size} selected`}
      </p>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border bg-background p-12 text-center">
          <ImageIcon className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            {search ? "No media matches your search" : "No media uploaded yet"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              className={`group relative rounded-lg border bg-background overflow-hidden cursor-pointer ${
                selected.has(item.id) ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => setPreviewMedia(item)}
            >
              {/* Select checkbox */}
              <div
                className="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOne(item.id);
                }}
              >
                <Checkbox
                  checked={selected.has(item.id)}
                  onCheckedChange={() => toggleOne(item.id)}
                  className="bg-white border-gray-300"
                />
              </div>

              {/* Thumbnail */}
              <div className="aspect-square bg-muted flex items-center justify-center">
                {isImage(item) ? (
                  <img
                    src={
                      item.file_path
                    }
                    alt={item.alt_text || item.original_filename}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
                )}
              </div>

              {/* Info */}
              <div className="p-2">
                <p className="text-xs font-medium truncate">
                  {item.original_filename}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(item.file_size)}
                </p>
              </div>

              {/* Hover actions */}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity flex justify-end gap-1">
                <Button
                  size="icon"
                  className="h-7 w-7 bg-white text-black hover:bg-white/90"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyUrl(item);
                  }}
                  title="Copy URL"
                >
                  {copiedId === item.id ? (
                    <Check className="h-3 w-3 text-green-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="destructive"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(item);
                  }}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview Dialog */}
      <Dialog
        open={!!previewMedia}
        onOpenChange={(o) => !o && setPreviewMedia(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{previewMedia?.original_filename}</DialogTitle>
          </DialogHeader>
          {previewMedia && (
            <div className="space-y-4">
              {isImage(previewMedia) && (
                <div className="rounded-lg overflow-hidden bg-muted flex items-center justify-center max-h-80">
                  <img
                    src={
                      previewMedia.file_path
                    }
                    alt={previewMedia.alt_text || previewMedia.original_filename}
                    className="max-w-full max-h-80 object-contain"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">File size</p>
                  <p>{formatFileSize(previewMedia.file_size)}</p>
                </div>
                {previewMedia.width && previewMedia.height && (
                  <div>
                    <p className="text-muted-foreground text-xs">Dimensions</p>
                    <p>
                      {previewMedia.width} × {previewMedia.height}px
                    </p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs">Type</p>
                  <p>{previewMedia.mime_type}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Uploaded</p>
                  <p>{formatDate(previewMedia.inserted_at)}</p>
                </div>
                {previewMedia.alt_text && (
                  <div className="col-span-2">
                    <p className="text-muted-foreground text-xs">Alt text</p>
                    <p>{previewMedia.alt_text}</p>
                  </div>
                )}
                <div className="col-span-2">
                  <p className="text-muted-foreground text-xs">URL</p>
                  <code className="text-xs break-all bg-muted rounded px-1 py-0.5 block mt-0.5">
                    {previewMedia.file_path}
                  </code>
                </div>
              </div>
              <div className="flex justify-between pt-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setDeleteTarget(previewMedia);
                    setPreviewMedia(null);
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
                <Button
                  size="sm"
                  onClick={() => copyUrl(previewMedia)}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy URL
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete single confirm */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Media</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.original_filename}&rdquo;?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.id)
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selected.size} Items</DialogTitle>
            <DialogDescription>
              This will permanently delete {selected.size} media items. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete}>
              Delete {selected.size} Items
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
