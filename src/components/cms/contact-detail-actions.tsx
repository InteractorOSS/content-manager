"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updateContactStatus, deleteContact } from "@/lib/api";

const STATUS_OPTIONS = [
  { value: "new", label: "New", variant: "default" as const },
  { value: "contacted", label: "Contacted", variant: "warning" as const },
  { value: "resolved", label: "Resolved", variant: "success" as const },
  { value: "spam", label: "Spam", variant: "muted" as const },
];

interface Props {
  submissionId: string;
  currentStatus: string;
  email: string;
  fullName: string;
}

export function ContactDetailActions({ submissionId, currentStatus, email, fullName }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (newStatus: string) => updateContactStatus(submissionId, newStatus),
    onSuccess: (updated) => {
      setStatus(updated.status);
      toast.success("Status updated");
    },
    onError: () => toast.error("Failed to update status"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteContact(submissionId),
    onSuccess: () => {
      toast.success("Contact deleted");
      router.push("/contacts");
    },
    onError: () => toast.error("Failed to delete contact"),
  });

  const opt = STATUS_OPTIONS.find((s) => s.value === status);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-muted-foreground text-xs mb-2">Current Status</p>
        <Badge variant={opt?.variant ?? "outline"} className="capitalize">
          {opt?.label ?? status}
        </Badge>
      </div>

      <div className="space-y-2">
        {STATUS_OPTIONS.filter((s) => s.value !== status).map((s) => (
          <Button
            key={s.value}
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => updateMutation.mutate(s.value)}
            disabled={updateMutation.isPending}
          >
            {updateMutation.isPending && (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            )}
            Mark {s.label}
          </Button>
        ))}
      </div>

      <div className="border-t pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete Submission
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Contact</DialogTitle>
            <DialogDescription>
              Delete submission from {fullName} ({email})? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
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
    </div>
  );
}
