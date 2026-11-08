"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MailPlus, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listInvitations,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  listRoles,
} from "@/lib/api";
import { FailureNotice } from "@/components/ui/failure-notice";
import { describeMemberFailure } from "@/lib/member-errors";
import { useMe } from "@/hooks/use-me";
import type { Invitation, Role } from "@/types/cms";
import { formatDate } from "@/lib/utils";

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  accepted: "secondary",
  revoked: "destructive",
  expired: "outline",
};

export function InvitationsManager() {
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleName, setRoleName] = useState("author");

  const {
    data: invitations = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Invitation[]>({
    queryKey: ["invitations"],
    queryFn: () => listInvitations(),
  });

  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ["roles"],
    queryFn: listRoles,
  });

  // An invitation is a deferred Membership.role, so the picker offers only
  // ORGANIZATION roles — "super_admin" is a global grant an invitation cannot
  // express, and listing it here is what made it look like an org role you
  // could hand out in two clicks. Roles this inviter may not grant stay visible
  // but disabled, with the reason, rather than vanishing: knowing the role
  // exists and who can hand it out is more use than a silently shorter list.
  const inviteRoles = roles.filter((r) => r.scope === "organization");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["invitations"] });

  const createMutation = useMutation({
    mutationFn: () => createInvitation({ email, name: name || undefined, role_name: roleName }),
    onSuccess: (invitation) => {
      toast.success(`Invitation created for ${invitation.email}`, {
        description:
          "They will get the role automatically the first time they sign in with this email.",
      });
      setCreateOpen(false);
      setEmail("");
      setName("");
      setRoleName("author");
      invalidate();
    },
    // No toast here: the dialog stays open on failure and says what happened
    // in place, next to the fields the reader may need to change.
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) => resendInvitation(id),
    onSuccess: () => {
      toast.success("Invitation refreshed for another 7 days");
      invalidate();
    },
    onError: (e) => toast.error(describeMemberFailure(e, "resend").message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onSuccess: () => {
      toast.success("Invitation revoked");
      invalidate();
    },
    onError: (e) => toast.error(describeMemberFailure(e, "revoke").message),
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
      {can("users:create") && (
        <div className="flex justify-end">
          <Button
            className="min-h-11"
            onClick={() => {
              // Don't reopen on last time's failure.
              createMutation.reset();
              setCreateOpen(true);
            }}
          >
            <MailPlus className="mr-2 h-4 w-4" />
            Invite user
          </Button>
        </div>
      )}

      {/* A failed load must not fall through to the empty table below: "No
          invitations yet" would be a statement about this organization, and the
          server never said it. */}
      {isError && (
        <FailureNotice
          failure={describeMemberFailure(error, "invitations_load")}
          onRetry={() => refetch()}
          refreshLabel="Reload invitations"
        />
      )}

      {isError && invitations.length === 0 ? null : (
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell>
                    <p className="text-sm font-medium">{invitation.email}</p>
                    {invitation.name && (
                      <p className="text-xs text-muted-foreground">{invitation.name}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {invitation.role_name}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_VARIANTS[invitation.status] ?? "outline"}
                      className="text-xs capitalize"
                    >
                      {invitation.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {invitation.invited_by?.name ?? invitation.invited_by?.email ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(invitation.expires_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {invitation.status === "pending" && can("users:create") && (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Extend expiry"
                          onClick={() => resendMutation.mutate(invitation.id)}
                          disabled={resendMutation.isPending}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title="Revoke invitation"
                          onClick={() => revokeMutation.mutate(invitation.id)}
                          disabled={revokeMutation.isPending}
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {invitations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                    No invitations yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create invitation dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>
              The invitee needs an Interactor account (auth.interactor.com). When they first sign
              in to the CMS with this email, the selected role is applied automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@interactor.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-name">Name (optional)</Label>
              <Input
                id="invite-name"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={roleName} onValueChange={setRoleName}>
                <SelectTrigger id="invite-role" className="min-h-11">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {inviteRoles.map((role) => (
                    <SelectItem key={role.name} value={role.name} disabled={!role.assignable}>
                      {role.display_name}
                      {!role.assignable && " — owner only"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {inviteRoles.find((r) => r.name === roleName)?.description && (
                <p className="text-xs text-muted-foreground">
                  {inviteRoles.find((r) => r.name === roleName)?.description}
                </p>
              )}
            </div>

            {/* The route's own refusals ("Super administrator is a global
                role…", "Valid email is required") are written for a person and
                pass straight through; everything underneath them — the guard's
                "Forbidden", the client's "HTTP 502", a Prisma stack — is
                replaced. */}
            {createMutation.isError && (
              <FailureNotice
                failure={describeMemberFailure(createMutation.error, "invite")}
                onRetry={() => createMutation.mutate()}
                onRefresh={() => {
                  setCreateOpen(false);
                  invalidate();
                }}
                refreshLabel="Reload invitations"
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !email}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {createMutation.isPending ? "Creating invitation…" : "Create invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
