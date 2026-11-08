"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Search,
  Loader2,
  Trash2,
  ShieldCheck,
  UserX,
  UserCheck,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { listUsers, listRoles, setMemberRole, updateUser, deleteUser } from "@/lib/api";
import { FailureNotice } from "@/components/ui/failure-notice";
import { describeMemberFailure } from "@/lib/member-errors";
import { ORG_OWNER } from "@/lib/member-roles";
import { useMe } from "@/hooks/use-me";
import type { CmsUser, Role } from "@/types/cms";
import { formatDate } from "@/lib/utils";

/** The role a member holds here, and — separately — cross-org staff access. */
function MemberRoles({ user }: { user: CmsUser }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant="secondary" className="text-xs">
        {user.membership_role_display_name}
      </Badge>
      {user.super_admin && (
        <Badge variant="outline" className="gap-1 text-xs">
          <Star className="h-3 w-3" aria-hidden="true" />
          Super admin
        </Badge>
      )}
    </div>
  );
}

/**
 * The row's controls. Declared at module level, not inside UsersManager: a
 * component re-created on every render remounts its buttons, which drops
 * keyboard focus mid-interaction.
 */
function MemberActions({
  user,
  can,
  selfId,
  statusPending,
  onEditRole,
  onToggleStatus,
  onDelete,
}: {
  user: CmsUser;
  can: (permission: string) => boolean;
  selfId: string | undefined;
  statusPending: boolean;
  onEditRole: (user: CmsUser) => void;
  onToggleStatus: (user: CmsUser) => void;
  onDelete: (user: CmsUser) => void;
}) {
  const who = user.name ?? user.email;
  return (
    <div className="flex items-center justify-end gap-1">
      {can("users:manage_roles") && (
        // Outline, not ghost: an icon-only ghost button next to a Badge reads
        // as a second badge rather than a clickable control — this is often
        // the ONLY action a viewer has permission for, so it can't rely on a
        // neighboring suspend/delete icon to signal "these are buttons".
        <Button
          variant="outline"
          className="h-11 gap-1.5 px-3"
          aria-label={`Change ${who}'s role`}
          title={`Change ${who}'s role`}
          onClick={() => onEditRole(user)}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          <span className="hidden lg:inline">Role</span>
        </Button>
      )}
      {can("users:edit") && user.id !== selfId && (
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={user.status === "active" ? `Suspend ${who}` : `Reactivate ${who}`}
          title={user.status === "active" ? "Suspend member" : "Reactivate member"}
          disabled={statusPending}
          onClick={() => onToggleStatus(user)}
        >
          {user.status === "active" ? (
            <UserX className="h-4 w-4" aria-hidden="true" />
          ) : (
            <UserCheck className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      )}
      {can("users:delete") && user.id !== selfId && (
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 text-muted-foreground hover:text-destructive"
          aria-label={`Delete ${who}`}
          title="Delete member"
          onClick={() => onDelete(user)}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/** Nothing to show — and which kind of nothing it is. */
function EmptyState({ search, onClear }: { search: string; onClear: () => void }) {
  if (search) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium">No members match “{search}”</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Search by name or email address.
        </p>
        <Button variant="outline" className="mt-4 min-h-11" onClick={onClear}>
          Clear search
        </Button>
      </div>
    );
  }
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium">No members yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Invite a teammate from the Invitations tab — their role appears here once they
        sign in.
      </p>
    </div>
  );
}

function MemberStatus({ status }: { status: string }) {
  const suspended = status !== "active";
  return (
    <Badge
      variant={suspended ? "destructive" : "default"}
      className="gap-1 text-xs capitalize"
    >
      {/* Text carries the meaning; the colour only reinforces it. */}
      {suspended ? (
        <UserX className="h-3 w-3" aria-hidden="true" />
      ) : (
        <UserCheck className="h-3 w-3" aria-hidden="true" />
      )}
      {status}
    </Badge>
  );
}

export function UsersManager() {
  const queryClient = useQueryClient();
  const { me, can } = useMe();
  const [search, setSearch] = useState("");
  const [roleTarget, setRoleTarget] = useState<CmsUser | null>(null);
  const [roleDraft, setRoleDraft] = useState("");
  const [superAdminDraft, setSuperAdminDraft] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CmsUser | null>(null);

  const {
    data: users = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<CmsUser[]>({
    queryKey: ["users"],
    queryFn: () => listUsers(),
  });

  // The role editor's picker. Rows carry their own display name, so this is
  // only fetched for the dialog — and only by someone who can open it.
  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ["roles"],
    queryFn: listRoles,
    enabled: can("users:manage_roles"),
  });

  const orgRoles = roles.filter((r) => r.scope === "organization");

  // Only a global super_admin may grant or revoke the global grant — the route
  // refuses it either way (src/lib/member-roles.ts), this just avoids offering
  // a control that could only fail. Read the dedicated flag, not the merged
  // `roles` list, which cannot tell the global grant from an org role of the
  // same name.
  const canManageSuperAdmin = me?.is_super_admin ?? false;

  // Offer only what this admin may actually hand out, plus the member's own
  // current role — which has to stay in the list even when it is out of reach
  // (an admin looking at the owner), or the picker would open showing nothing
  // selected and invite a change that was never asked for.
  const selectableRoles = roleTarget
    ? orgRoles.filter((r) => r.assignable || r.name === roleTarget.membership_role)
    : [];
  // Demoting the sitting owner is the owner's own privilege (roleGrantRefusal).
  const ownerLocked =
    !!roleTarget &&
    roleTarget.membership_role === ORG_OWNER &&
    !orgRoles.some((r) => r.name === ORG_OWNER && r.assignable);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const rolesMutation = useMutation({
    mutationFn: ({ id, role, superAdmin }: { id: string; role: string; superAdmin: boolean }) =>
      setMemberRole(id, {
        role,
        ...(canManageSuperAdmin ? { super_admin: superAdmin } : {}),
      }),
    onSuccess: () => {
      toast.success("Role updated");
      setRoleTarget(null);
      invalidate();
      // A member can re-role themselves, which changes what this very session
      // is allowed to do — the gated controls have to be re-read.
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateUser(id, { status }),
    onSuccess: () => {
      toast.success("Member updated");
      invalidate();
    },
    onError: (e) => toast.error(describeMemberFailure(e, "save").message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      toast.success("Member deleted");
      setDeleteTarget(null);
      invalidate();
    },
    onError: (e) => toast.error(describeMemberFailure(e, "save").message),
  });

  const filtered = users.filter(
    (u) =>
      !search ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.name ?? "").toLowerCase().includes(search.toLowerCase())
  );

  // "No one else is here yet" is a different situation from "nothing matched",
  // and the only member an org always has is the person reading the page.
  const aloneInOrg = users.length === 1 && users[0]?.id === me?.user.id;

  function openRoleEditor(user: CmsUser) {
    rolesMutation.reset();
    setRoleTarget(user);
    setRoleDraft(user.membership_role);
    setSuperAdminDraft(user.super_admin);
  }

  const actionProps = {
    can,
    selfId: me?.user.id,
    statusPending: statusMutation.isPending,
    onEditRole: openRoleEditor,
    onToggleStatus: (user: CmsUser) =>
      statusMutation.mutate({
        id: user.id,
        status: user.status === "active" ? "suspended" : "active",
      }),
    onDelete: (user: CmsUser) => setDeleteTarget(user),
  };

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="Search members by name or email"
          placeholder="Search members..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-11 pl-9"
        />
      </div>

      {/* A failed REFRESH keeps the rows it already had — they are still the
          last thing the server said, and blanking the page over a dropped
          connection takes away the reader's context as well as their data. */}
      {isError && (
        <FailureNotice
          failure={describeMemberFailure(error, "load")}
          onRetry={() => refetch()}
        />
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full sm:h-12" />
          ))}
        </div>
      ) : isError && users.length === 0 ? null : (
        <>
          {/* Below md the six-column table can only scroll sideways, so the
              same rows are stacked as cards instead — same data, same
              controls, no horizontal scrolling. */}
          <ul className="divide-y rounded-lg border bg-background md:hidden">
            {filtered.map((user) => (
              <li key={user.membership_id} className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {user.name ?? user.email}
                    </p>
                    {user.name && (
                      <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                    )}
                  </div>
                  <MemberStatus status={user.status} />
                </div>
                <MemberRoles user={user} />
                <p className="text-xs text-muted-foreground">
                  {user.post_count} {user.post_count === 1 ? "post" : "posts"} · Last login{" "}
                  {user.last_login_at ? formatDate(user.last_login_at) : "never"}
                </p>
                <MemberActions user={user} {...actionProps} />
              </li>
            ))}
            {filtered.length === 0 && (
              <li>
                <EmptyState search={search} onClear={() => setSearch("")} />
              </li>
            )}
          </ul>

          <div className="hidden rounded-lg border bg-background md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Posts</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((user) => (
                  <TableRow key={user.membership_id}>
                    <TableCell>
                      <div>
                        <p className="text-sm font-medium">{user.name ?? user.email}</p>
                        {user.name && (
                          <p className="text-xs text-muted-foreground">{user.email}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* One role in this organization, plus the global grant as
                          a separate badge — they are different things and a
                          single merged list said otherwise. */}
                      <MemberRoles user={user} />
                    </TableCell>
                    <TableCell>
                      <MemberStatus status={user.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {user.post_count}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {user.last_login_at ? formatDate(user.last_login_at) : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <MemberActions user={user} {...actionProps} />
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState search={search} onClear={() => setSearch("")} />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {aloneInOrg && (
            <p className="text-sm text-muted-foreground">
              You&apos;re the only member of{" "}
              {me?.organization ? me.organization.name : "this organization"}. Invite a
              teammate from the Invitations tab to give someone else a role.
            </p>
          )}
        </>
      )}

      {/* Role editor. One role per person per organization — the picker is a
          single choice rather than a checkbox list, because Membership.role is
          single-valued and a tick list could ask for something unsavable. */}
      <Dialog open={!!roleTarget} onOpenChange={(open) => !open && setRoleTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role</DialogTitle>
            <DialogDescription>
              What {roleTarget?.name ?? roleTarget?.email} can do
              {me?.organization ? ` in ${me.organization.name}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="member-role">Role</Label>
              <Select value={roleDraft} onValueChange={setRoleDraft} disabled={ownerLocked}>
                <SelectTrigger id="member-role" className="min-h-11">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {selectableRoles.map((role) => (
                    <SelectItem key={role.name} value={role.name} className="min-h-11">
                      {role.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {ownerLocked ? (
                <p className="text-xs text-muted-foreground">
                  Only the organization&apos;s owner can change the owner&apos;s role.
                  Ask your owner to make this change.
                </p>
              ) : (
                selectableRoles.find((r) => r.name === roleDraft)?.description && (
                  <p className="text-xs text-muted-foreground">
                    {selectableRoles.find((r) => r.name === roleDraft)?.description}
                  </p>
                )
              )}
            </div>

            {canManageSuperAdmin && (
              <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <Label htmlFor="member-super-admin" className="text-sm font-medium">
                    Super administrator
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Full access to every organization, on top of the role above. Only
                    super administrators can grant this.
                  </p>
                </div>
                <Switch
                  id="member-super-admin"
                  checked={superAdminDraft}
                  onCheckedChange={setSuperAdminDraft}
                />
              </div>
            )}

            {rolesMutation.isError && (
              <FailureNotice
                failure={describeMemberFailure(rolesMutation.error, "save")}
                onRetry={() =>
                  roleTarget &&
                  rolesMutation.mutate({
                    id: roleTarget.id,
                    role: roleDraft,
                    superAdmin: superAdminDraft,
                  })
                }
                onRefresh={() => {
                  setRoleTarget(null);
                  invalidate();
                }}
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setRoleTarget(null)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              onClick={() =>
                roleTarget &&
                rolesMutation.mutate({
                  id: roleTarget.id,
                  role: roleDraft,
                  superAdmin: superAdminDraft,
                })
              }
              disabled={rolesMutation.isPending || !roleDraft}
            >
              {rolesMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {rolesMutation.isPending ? "Saving role…" : "Save role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete member</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget?.name ?? deleteTarget?.email}? Their posts remain but lose the
              author link. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              Delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
