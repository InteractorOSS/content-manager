"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { listWaitlistEntries, updateWaitlistStatus, deleteWaitlistEntry } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { WaitlistEntry } from "@/types/cms";

function StatusBadge({ status }: { status: string }) {
  if (status === "pending") return <Badge variant="warning">Pending</Badge>;
  if (status === "confirmed") return <Badge variant="success">Confirmed</Badge>;
  if (status === "invited") return <Badge variant="default">Invited</Badge>;
  if (status === "cancelled") return <Badge variant="muted">Cancelled</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export function WaitlistTable() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<WaitlistEntry | null>(null);

  const { data: entries = [], isLoading } = useQuery<WaitlistEntry[]>({
    queryKey: ["waitlist"],
    queryFn: listWaitlistEntries,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateWaitlistStatus(id, status),
    onSuccess: () => {
      toast.success("Status updated");
      queryClient.invalidateQueries({ queryKey: ["waitlist"] });
    },
    onError: () => toast.error("Failed to update status"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteWaitlistEntry(id),
    onSuccess: () => {
      toast.success("Entry removed");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["waitlist"] });
    },
    onError: () => toast.error("Failed to remove entry"),
  });

  const counts = {
    total: entries.length,
    pending: entries.filter((e) => e.status === "pending").length,
    confirmed: entries.filter((e) => e.status === "confirmed").length,
    invited: entries.filter((e) => e.status === "invited").length,
  };

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
          { label: "Total", value: counts.total, color: "text-gray-600", bg: "bg-gray-50" },
          { label: "Pending", value: counts.pending, color: "text-yellow-600", bg: "bg-yellow-50" },
          { label: "Confirmed", value: counts.confirmed, color: "text-green-600", bg: "bg-green-50" },
          { label: "Invited", value: counts.invited, color: "text-blue-600", bg: "bg-blue-50" },
        ].map((stat) => (
          <div
            key={stat.label}
            className={`rounded-lg border p-3 ${stat.bg}`}
          >
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-24">Source</TableHead>
              <TableHead className="w-36">IP Address</TableHead>
              <TableHead className="w-40">Signed Up</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <p className="text-sm text-muted-foreground">
                    No waitlist entries yet
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-medium text-sm">{entry.email}</TableCell>
                  <TableCell>
                    <StatusBadge status={entry.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {entry.source ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {entry.ipAddress ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatDateTime(entry.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {entry.status === "pending" && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: entry.id, status: "confirmed" })
                            }
                          >
                            Mark Confirmed
                          </DropdownMenuItem>
                        )}
                        {(entry.status === "pending" || entry.status === "confirmed") && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: entry.id, status: "invited" })
                            }
                          >
                            Mark Invited
                          </DropdownMenuItem>
                        )}
                        {entry.status !== "cancelled" && (
                          <DropdownMenuItem
                            className="gap-2 text-yellow-600 focus:text-yellow-600"
                            onClick={() =>
                              updateMutation.mutate({ id: entry.id, status: "cancelled" })
                            }
                          >
                            Cancel
                          </DropdownMenuItem>
                        )}
                        {entry.status === "cancelled" && (
                          <DropdownMenuItem
                            className="gap-2"
                            onClick={() =>
                              updateMutation.mutate({ id: entry.id, status: "pending" })
                            }
                          >
                            Restore to Pending
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-2 text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(entry)}
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
        {entries.length} total entries
      </p>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from Waitlist</DialogTitle>
            <DialogDescription>
              Remove {deleteTarget?.email} from the waitlist? This cannot be undone.
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
    </div>
  );
}
