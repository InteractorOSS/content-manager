"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, ChevronDown, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listNewsletterSubscriptions,
  updateNewsletterStatus,
  deleteNewsletterSubscription,
} from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { NewsletterSubscription } from "@/types/cms";

function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="success">Active</Badge>;
  if (status === "unsubscribed") return <Badge variant="warning">Unsubscribed</Badge>;
  if (status === "bounced") return <Badge variant="destructive">Bounced</Badge>;
  return <Badge variant="muted">{status}</Badge>;
}

export function NewsletterTable() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<NewsletterSubscription | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: subscriptions = [], isLoading } = useQuery<NewsletterSubscription[]>({
    queryKey: ["newsletter"],
    queryFn: listNewsletterSubscriptions,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateNewsletterStatus(id, status),
    onSuccess: () => {
      toast.success("Status updated");
      queryClient.invalidateQueries({ queryKey: ["newsletter"] });
    },
    onError: () => toast.error("Failed to update status"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNewsletterSubscription(id),
    onSuccess: () => {
      toast.success("Subscription removed");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["newsletter"] });
    },
    onError: () => toast.error("Failed to remove subscription"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map(deleteNewsletterSubscription)),
    onSuccess: () => {
      toast.success(`Removed ${selected.size} subscriptions`);
      setSelected(new Set());
      setBulkDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: ["newsletter"] });
    },
    onError: () => toast.error("Failed to remove subscriptions"),
  });

  const filtered = subscriptions.filter((s) => {
    const matchesSearch =
      !search || s.email.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || s.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const counts = {
    total: subscriptions.length,
    active: subscriptions.filter((s) => s.status === "active").length,
    unsubscribed: subscriptions.filter((s) => s.status === "unsubscribed").length,
    bounced: subscriptions.filter((s) => s.status === "bounced").length,
  };

  const allSelected =
    filtered.length > 0 && filtered.every((s) => selected.has(s.id));

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((s) => s.id)));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Total", value: counts.total, color: "text-gray-600", bg: "bg-gray-50", filter: "all" },
          { label: "Active", value: counts.active, color: "text-green-600", bg: "bg-green-50", filter: "active" },
          { label: "Unsubscribed", value: counts.unsubscribed, color: "text-yellow-600", bg: "bg-yellow-50", filter: "unsubscribed" },
          { label: "Bounced", value: counts.bounced, color: "text-red-600", bg: "bg-red-50", filter: "bounced" },
        ].map((stat) => (
          <button
            key={stat.label}
            onClick={() => setStatusFilter(stat.filter)}
            className={`rounded-lg border p-3 text-left transition-all hover:shadow-sm ${
              statusFilter === stat.filter ? "ring-2 ring-primary" : ""
            } ${stat.bg}`}
          >
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
            <SelectItem value="bounced">Bounced</SelectItem>
          </SelectContent>
        </Select>
        {selected.size > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Remove ({selected.size})
          </Button>
        )}
        {(statusFilter !== "all" || search) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStatusFilter("all"); setSearch(""); }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="w-36">Name</TableHead>
              <TableHead className="w-36">Company</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-24">Source</TableHead>
              <TableHead className="w-32">Subscribed</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12">
                  <p className="text-sm text-muted-foreground">
                    {search || statusFilter !== "all"
                      ? "No subscriptions match your filters"
                      : "No newsletter subscriptions yet"}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((sub) => (
                <TableRow
                  key={sub.id}
                  data-state={selected.has(sub.id) ? "selected" : undefined}
                  className={
                    sub.status !== "active" ? "opacity-60" : undefined
                  }
                >
                  <TableCell>
                    <Checkbox
                      checked={selected.has(sub.id)}
                      onCheckedChange={() => toggleOne(sub.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium text-sm">{sub.email}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {sub.firstName || sub.lastName
                      ? `${sub.firstName ?? ""} ${sub.lastName ?? ""}`.trim()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {sub.company ?? "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={sub.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {sub.source ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatDate(sub.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {sub.status !== "active" && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: sub.id, status: "active" })
                            }
                          >
                            Reactivate
                          </DropdownMenuItem>
                        )}
                        {sub.status === "active" && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: sub.id, status: "unsubscribed" })
                            }
                          >
                            Unsubscribe
                          </DropdownMenuItem>
                        )}
                        {sub.status !== "bounced" && (
                          <DropdownMenuItem
                            className="gap-2 text-yellow-600 focus:text-yellow-600"
                            onClick={() =>
                              updateMutation.mutate({ id: sub.id, status: "bounced" })
                            }
                          >
                            Mark Bounced
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-2 text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(sub)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {subscriptions.length} subscriptions
      </p>

      {/* Delete single */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Subscription</DialogTitle>
            <DialogDescription>
              Remove {deleteTarget?.email} from the newsletter list? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {selected.size} Subscriptions</DialogTitle>
            <DialogDescription>
              Remove {selected.size} selected subscriptions? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate([...selected])}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
