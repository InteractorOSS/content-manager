"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
} from "@/lib/social-api";
import { useMe } from "@/hooks/use-me";
import type { SocialCampaign } from "@/types/social";

interface CampaignDialogProps {
  campaign?: SocialCampaign;
  open: boolean;
  onClose: () => void;
}

function CampaignDialog({ campaign, open, onClose }: CampaignDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [description, setDescription] = useState("");
  const [recycle, setRecycle] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(campaign?.name ?? "");
    setColor(campaign?.color ?? "#3b82f6");
    setDescription(campaign?.description ?? "");
    setRecycle(campaign?.recycle ?? false);
  }, [open, campaign]);

  const mutation = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), color, description, recycle };
      return campaign
        ? updateCampaign(campaign.id, input)
        : createCampaign(input);
    },
    onSuccess: () => {
      toast.success(campaign ? "Campaign updated" : "Campaign created");
      queryClient.invalidateQueries({ queryKey: ["social-campaigns"] });
      onClose();
    },
    onError: () => toast.error("Failed to save campaign"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {campaign ? "Edit Campaign" : "New Campaign"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) mutation.mutate();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              placeholder="Campaign name..."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-10 w-10 rounded border cursor-pointer"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
              <Input
                placeholder="#3b82f6"
                className="font-mono text-sm"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              placeholder="Optional description..."
              className="resize-none"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label>Recycle</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Evergreen: content can be re-queued
              </p>
            </div>
            <Switch checked={recycle} onCheckedChange={setRecycle} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || !name.trim()}
            >
              {mutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {campaign ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CampaignsManager() {
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SocialCampaign | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<SocialCampaign | null>(
    null
  );

  const { data: campaigns = [], isLoading } = useQuery<SocialCampaign[]>({
    queryKey: ["social-campaigns"],
    queryFn: listCampaigns,
  });

  const recycleMutation = useMutation({
    mutationFn: ({ id, recycle }: { id: string; recycle: boolean }) =>
      updateCampaign(id, { recycle }),
    onSuccess: () => {
      toast.success("Campaign updated");
      queryClient.invalidateQueries({ queryKey: ["social-campaigns"] });
    },
    onError: () => toast.error("Failed to update campaign"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCampaign(id),
    onSuccess: () => {
      toast.success("Campaign deleted");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["social-campaigns"] });
    },
    onError: () => toast.error("Failed to delete campaign"),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {can("content:create") && (
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setEditTarget(undefined);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            New Campaign
          </Button>
        </div>
      )}

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-24">Recycle</TableHead>
              <TableHead className="w-24">Posts</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10">
                  <p className="text-sm text-muted-foreground">
                    No campaigns yet
                  </p>
                  {can("content:create") && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => setDialogOpen(true)}
                    >
                      Create first campaign
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              campaigns.map((campaign) => (
                <TableRow key={campaign.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div
                        className="h-4 w-4 shrink-0 rounded-full border"
                        style={{
                          backgroundColor: campaign.color || "#3b82f6",
                        }}
                      />
                      <span className="font-medium text-sm">
                        {campaign.name}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                    {campaign.description || "—"}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={campaign.recycle}
                      disabled={
                        !can("content:edit") || recycleMutation.isPending
                      }
                      onCheckedChange={(checked) =>
                        recycleMutation.mutate({
                          id: campaign.id,
                          recycle: checked,
                        })
                      }
                      aria-label="Toggle recycle"
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {campaign.post_count ?? 0}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {can("content:edit") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Edit campaign"
                          onClick={() => {
                            setEditTarget(campaign);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {can("content:delete") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          aria-label="Delete campaign"
                          onClick={() => setDeleteTarget(campaign)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <CampaignDialog
        campaign={editTarget}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditTarget(undefined);
        }}
      />

      {/* Delete confirm */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Campaign</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;?
            Posts in this campaign will keep their content but lose the
            campaign label.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.id)
              }
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
