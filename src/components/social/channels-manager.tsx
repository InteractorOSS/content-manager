"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureNotice } from "@/components/ui/failure-notice";
import {
  describeChannelConnectFailure,
  type ChannelConnectFailure,
} from "@/lib/social/connect-errors";
import {
  listChannels,
  listConnectableServices,
  connectChannel,
  connectManualChannel,
  updateChannel,
  disconnectChannel,
  listChannelAccounts,
  setChannelDestinations,
} from "@/lib/social-api";
import { useMe } from "@/hooks/use-me";
import { slugify } from "@/lib/slug";
import { DISABLED_BUTTON } from "@/components/social/media-picker";
import { cn } from "@/lib/utils";
import type {
  ChannelAccountOption,
  ConnectableService,
  SocialChannel,
  SocialChannelStatus,
} from "@/types/social";

const STATUS_VARIANTS: Record<
  SocialChannelStatus,
  "success" | "warning" | "destructive"
> = {
  active: "success",
  pending: "warning",
  expired: "destructive",
  revoked: "destructive",
  error: "destructive",
};

function ChannelStatusBadge({ status }: { status: SocialChannelStatus }) {
  return (
    <Badge variant={STATUS_VARIANTS[status]} className="capitalize">
      {status}
    </Badge>
  );
}

/**
 * The places one sign-in posts to. A connection is every SocialChannel row
 * sharing a Core identity (`external_user_id`) on one service; a manual
 * channel is always a connection of one.
 */
interface Connection {
  key: string;
  /** The row any connection-level call (accounts, destinations, reconnect) goes through. */
  anchor: SocialChannel;
  /** Rows that point somewhere — a Page, a Slack channel, a subreddit. */
  places: SocialChannel[];
  status: SocialChannelStatus;
}

function groupConnections(channels: SocialChannel[]): Connection[] {
  const groups = new Map<string, SocialChannel[]>();
  for (const channel of channels) {
    const key =
      channel.delivery_mode === "manual"
        ? `manual:${channel.id}`
        : `${channel.service_id}:${channel.external_user_id}`;
    groups.set(key, [...(groups.get(key) ?? []), channel]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const oldestFirst = [...rows].sort((a, b) => a.inserted_at.localeCompare(b.inserted_at));
    return {
      key,
      anchor: oldestFirst[0],
      places: oldestFirst.filter((r) => r.account_id || r.delivery_mode === "manual"),
      // The rows share a credential, so they share a status; if they ever
      // disagree, show the one that needs attention.
      status: oldestFirst.find((r) => r.status !== "active")?.status ?? "active",
    };
  });
}

/**
 * One card per network. Clicking it goes straight to that network's sign-in —
 * there is nothing to fill in first: where the connection posts (which Page,
 * which Slack channel) is chosen after it exists, from what it can reach.
 */
function NetworkCards({
  services,
  connections,
  loading,
  onPick,
  pendingServiceId,
}: {
  services: ConnectableService[];
  connections: Connection[];
  loading: boolean;
  onPick: (service: ConnectableService) => void;
  pendingServiceId: string | null;
}) {
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => {
        const connected = connections.filter(
          (c) => c.anchor.service_id === service.service_id && c.anchor.delivery_mode !== "manual"
        ).length;
        const pending = pendingServiceId === service.service_id;
        return (
          <button
            key={service.service_id}
            type="button"
            disabled={!service.available || pendingServiceId !== null}
            onClick={() => onPick(service)}
            className="flex items-center justify-between gap-3 rounded-lg border bg-background p-4 text-left transition-colors hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-background"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{service.display_name}</span>
              <span className="block text-xs text-muted-foreground">
                {!service.available
                  ? "Not available yet"
                  : connected === 0
                    ? "Sign in to connect"
                    : `${connected} connected · add another account`}
              </span>
            </span>
            {pending ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Choose where a connection posts. A network that can list its own accounts
 * (Facebook Pages, LinkedIn profile and company pages, Instagram business
 * accounts, Slack channels) shows them as a checklist and never asks for an
 * id; one that can't (a subreddit is a choice, not something the sign-in
 * owns) takes typed names.
 */
function PlacesDialog({
  connection,
  service,
  onClose,
  onReconnect,
  reconnecting,
}: {
  connection: Connection | null;
  service: ConnectableService | undefined;
  onClose: () => void;
  onReconnect: (channelId: string) => void;
  reconnecting: boolean;
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<ChannelAccountOption[]>([]);
  const [typed, setTyped] = useState("");
  const anchor = connection?.anchor;
  const label = service?.account_label || "place";
  // Until /api/social/services answers, assume the network lists its
  // accounts: a failed list then offers Try again and Reconnect rather than
  // asking a LinkedIn or Instagram user to type an id.
  const discovers = service ? !!service.discovers_accounts : true;

  useEffect(() => {
    if (!connection) return;
    setTyped("");
    setPicked(
      connection.places.map((p) => ({ id: p.account_id!, name: p.account_name || p.account_id! }))
    );
  }, [connection]);

  const accountsQuery = useQuery({
    queryKey: ["social-channel-accounts", anchor?.id],
    queryFn: () => listChannelAccounts(anchor!.id),
    enabled: !!anchor,
    retry: false,
  });
  const options = accountsQuery.data?.supported ? accountsQuery.data.accounts : null;
  // Places this connection already posts to that the network no longer
  // lists (access to a Page was removed). Shown so they can be unticked,
  // rather than kept invisibly on the next save.
  const unreachable: ChannelAccountOption[] = options
    ? (connection?.places ?? [])
        .filter((p) => !options.some((o) => o.id === p.account_id))
        .map((p) => ({ id: p.account_id!, name: p.account_name || p.account_id! }))
    : [];
  const listFailed = accountsQuery.isError && discovers;
  // Nothing to choose from: the network listed nothing, or the list failed.
  // The notice above carries the next step, so Save would be a dead button.
  const nothingToChoose =
    listFailed || (!!options && options.length === 0 && unreachable.length === 0);

  const saveMutation = useMutation({
    mutationFn: () =>
      setChannelDestinations(
        anchor!.id,
        picked.map(({ id, name }) => ({ id, name }))
      ),
    onSuccess: () => {
      toast.success("Saved where this connection posts");
      queryClient.invalidateQueries({ queryKey: ["social-channels"] });
      onClose();
    },
    onError: (err) =>
      toast.error(
        err instanceof Error && err.message && !err.message.startsWith("HTTP ")
          ? err.message
          : "Couldn't save where this connection posts. Nothing was changed."
      ),
  });

  const toggle = (option: ChannelAccountOption, on: boolean) =>
    setPicked((current) =>
      on
        ? [...current.filter((p) => p.id !== option.id), option]
        : current.filter((p) => p.id !== option.id)
    );

  const addTyped = () => {
    const id = typed.trim().replace(/^\/?r\//i, "");
    if (!id) return;
    toggle({ id, name: id }, true);
    setTyped("");
  };

  const listFailure = {
    message:
      accountsQuery.error instanceof Error &&
      accountsQuery.error.message &&
      !accountsQuery.error.message.startsWith("HTTP ")
        ? accountsQuery.error.message
        : `We couldn't get the list of each ${label} from the network. Nothing was changed. Try again.`,
    action: "retry" as const,
  };

  // The way out of both an empty list and a failed one: sign in again and
  // share more with the CMS. 44px everywhere so it lines up with the
  // notice's Try again; full width on a phone only when it stands alone.
  const reconnectButton = (alone: boolean) =>
    anchor && (
      <Button
        type="button"
        variant="outline"
        className={cn("min-h-11", alone && "w-full sm:w-auto", DISABLED_BUTTON)}
        disabled={reconnecting}
        aria-busy={reconnecting || undefined}
        onClick={() => onReconnect(anchor.id)}
      >
        {reconnecting && (
          <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        )}
        {reconnecting ? "Opening sign-in…" : `Reconnect ${anchor.service_name}`}
      </Button>
    );

  return (
    <Dialog open={!!connection} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto outline-none sm:max-w-md"
        // The list arrives after the dialog opens, so Radix would focus Cancel,
        // the only control there yet. Focus the dialog; Tab reaches the list.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Where should this connection post?</DialogTitle>
          <DialogDescription>
            Choose each {label} you want to post to. You can turn any of them off for a
            single post later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {accountsQuery.isLoading && (
            <p role="status" className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Looking up what this connection can post to…
            </p>
          )}

          {listFailed && (
            <FailureNotice
              failure={listFailure}
              onRetry={() => accountsQuery.refetch()}
              retryLabel="Try again"
              retryPending={accountsQuery.isFetching}
              retryPendingLabel="Trying again…"
            >
              {reconnectButton(false)}
            </FailureNotice>
          )}

          {options && options.length === 0 && unreachable.length === 0 && (
            <div className="space-y-3 rounded-lg border border-dashed p-4">
              <p className="text-sm">
                {service?.no_accounts_help ||
                  `This connection can't reach any ${label} yet. Reconnect it and share the ones you want when the network asks.`}
              </p>
              {reconnectButton(true)}
            </div>
          )}

          {options && options.length + unreachable.length > 0 && (
            // min-w-0: a fieldset is min-content wide by default, so one long
            // company name would push the dialog past a phone's edge.
            <fieldset className="min-w-0 space-y-2">
              <legend className="sr-only">Choose each {label}</legend>
              <div className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                {[...options, ...unreachable].map((option) => {
                  const gone = unreachable.includes(option);
                  const detail = gone
                    ? "This sign-in can't reach it any more. Untick it to stop posting here."
                    : option.detail;
                  return (
                    <label
                      key={option.id}
                      className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-accent has-[:focus-visible]:bg-accent"
                    >
                      <Checkbox
                        checked={picked.some((p) => p.id === option.id)}
                        onCheckedChange={(on) => toggle(option, on === true)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 break-words font-medium" title={option.name}>
                          {option.name}
                        </span>
                        {detail && (
                          <span className="block text-xs text-muted-foreground">{detail}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {picked.length === 0
                  ? "Nothing chosen. This connection won't post anywhere until you choose one."
                  : `${picked.length} chosen`}
              </p>
            </fieldset>
          )}

          {!accountsQuery.isLoading && !options && !listFailed && (
            <>
              {accountsQuery.isError && (
                <p className="text-sm text-muted-foreground">
                  We couldn&apos;t load the list from the network, so type the {label} instead.
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  aria-label={label}
                  className="h-11"
                  placeholder={
                    anchor?.service_id === "reddit" ? "Subreddit name, e.g. webdev" : label
                  }
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTyped();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className={cn("h-11", DISABLED_BUTTON)}
                  onClick={addTyped}
                  disabled={!typed.trim()}
                >
                  Add
                </Button>
              </div>
              {picked.length > 0 && (
                <div className="divide-y rounded-lg border">
                  {picked.map((p) => (
                    <div key={p.id} className="flex min-h-11 items-center justify-between px-3 py-1 text-sm">
                      <span className="truncate">{p.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11"
                        onClick={() => toggle(p, false)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" className="h-11" onClick={onClose}>
            {nothingToChoose ? "Close" : "Cancel"}
          </Button>
          {!nothingToChoose && (
            <Button
              type="button"
              className={cn("h-11", DISABLED_BUTTON)}
              disabled={saveMutation.isPending || accountsQuery.isLoading}
              aria-busy={saveMutation.isPending || undefined}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              )}
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
        {saveMutation.isPending && (
          <p role="status" className="sr-only">
            Saving…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * G#27: connect a manual-delivery channel — one with no API access at all
 * (e.g. a personal Facebook profile; Meta's Graph API only supports posting
 * to Pages, never on someone's behalf). No OAuth flow: the channel is
 * created active immediately, and its posts land in the manual queue
 * (Social > Manual queue) for a human to paste and mark posted. General on
 * purpose — the network label is freeform, not a fixed Facebook-only list.
 */
interface ManualChannelDialogProps {
  open: boolean;
  onClose: () => void;
}

function ManualChannelDialog({ open, onClose }: ManualChannelDialogProps) {
  const queryClient = useQueryClient();
  const [network, setNetwork] = useState("");
  const [accountName, setAccountName] = useState("");

  useEffect(() => {
    if (!open) return;
    setNetwork("");
    setAccountName("");
  }, [open]);

  const createMutation = useMutation({
    mutationFn: () =>
      connectManualChannel({
        service_id: slugify(network) || "manual",
        service_name: network.trim(),
        account_name: accountName.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Manual channel added");
      queryClient.invalidateQueries({ queryKey: ["social-channels"] });
      onClose();
    },
    onError: () => toast.error("Failed to add manual channel"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add manual channel</DialogTitle>
          <DialogDescription>
            For accounts with no API access at all — like a personal Facebook
            profile. Posts targeting this channel go to the manual queue for
            you to paste and post yourself.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Network / service</Label>
            <Input
              placeholder="e.g. Facebook (personal profile)"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Account name (optional)</Label>
            <Input
              placeholder="e.g. Jane's profile"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!network.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Add channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Rename how a place is labelled in the CMS. Where it posts is chosen in
 *  PlacesDialog, from what the connection can actually reach. */
function RenameDialog({
  channel,
  onClose,
}: {
  channel: SocialChannel | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  useEffect(() => {
    if (channel) setName(channel.account_name ?? "");
  }, [channel]);

  const renameMutation = useMutation({
    mutationFn: () => updateChannel(channel!.id, { account_name: name.trim() }),
    onSuccess: () => {
      toast.success("Name saved");
      queryClient.invalidateQueries({ queryKey: ["social-channels"] });
      onClose();
    },
    onError: () => toast.error("Couldn't save the name. Nothing was changed."),
  });

  return (
    <Dialog open={!!channel} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>
            This only changes the label shown in the CMS, not anything on the network.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Display name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={renameMutation.isPending}
            onClick={() => renameMutation.mutate()}
          >
            {renameMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TROUBLE_COPY: Partial<Record<SocialChannelStatus, string>> = {
  pending: "The sign-in wasn't finished, so nothing can be posted yet.",
  expired: "The network signed this connection out. Posts won't go out until you reconnect.",
  error: "The network stopped accepting this connection. Posts won't go out until you reconnect.",
  revoked: "Access was removed at the network. Reconnect to post again.",
};

export function ChannelsManager() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [manualOpen, setManualOpen] = useState(false);
  const [placesTarget, setPlacesTarget] = useState<Connection | null>(null);
  const [renameTarget, setRenameTarget] = useState<SocialChannel | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<Connection | null>(null);
  const [connectFailure, setConnectFailure] =
    useState<ChannelConnectFailure | null>(null);
  const [pendingServiceId, setPendingServiceId] = useState<string | null>(null);
  // The channel a sign-in just connected, when it can reach several places
  // (or none): its picker opens as soon as the channel list has loaded.
  const [chooseChannelId, setChooseChannelId] = useState<string | null>(null);

  // Result of the hosted-OAuth round trip (?connected=1 / ?connected=0&reason=…).
  // A success is a toast; a failure is a banner that stays put, because it has
  // something to say and something to do, and a toast that has already faded
  // leaves the reader with a channel stuck at "Pending" and no explanation.
  // The raw `reason` token never reaches the page — connect-errors.ts turns it
  // into a sentence.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected === null) return;
    if (connected === "1") {
      const choose = params.get("choose");
      toast.success(choose ? "Connected. Now choose where it posts." : "Connected");
      setChooseChannelId(choose);
      setConnectFailure(null);
    } else {
      setConnectFailure(describeChannelConnectFailure(params.get("reason")));
    }
    router.replace(window.location.pathname);
  }, [router]);

  const { data: channels = [], isLoading } = useQuery<SocialChannel[]>({
    queryKey: ["social-channels"],
    queryFn: listChannels,
  });
  const { data: services = [], isLoading: servicesLoading } = useQuery<ConnectableService[]>({
    queryKey: ["social-services"],
    queryFn: listConnectableServices,
  });

  const connections = groupConnections(channels);
  const serviceOf = (serviceId: string) => services.find((s) => s.service_id === serviceId);

  useEffect(() => {
    if (!chooseChannelId || isLoading) return;
    const connection = groupConnections(channels).find(
      (c) => c.anchor.id === chooseChannelId || c.places.some((p) => p.id === chooseChannelId)
    );
    if (connection) setPlacesTarget(connection);
    setChooseChannelId(null);
  }, [chooseChannelId, channels, isLoading]);

  // Both a new connection and a reconnect end the same way: the browser goes
  // to the network's own sign-in page.
  const connectMutation = useMutation({
    mutationFn: (input: { service_id?: string; reconnect_channel_id?: string }) =>
      connectChannel(input),
    onSuccess: (result) => {
      window.location.href = result.authorization_url;
    },
    onError: (err) => {
      setPendingServiceId(null);
      toast.error(
        // The server's sentence already says what happened and what to do.
        err instanceof Error && err.message && !err.message.startsWith("HTTP ")
          ? err.message
          : "Couldn't start the sign-in. Nothing was connected."
      );
    },
  });

  const defaultMutation = useMutation({
    mutationFn: (input: { id: string; on: boolean }) =>
      updateChannel(input.id, { default_target: input.on }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["social-channels"] }),
    onError: () => toast.error("Couldn't save that. Nothing was changed."),
  });

  const disconnectMutation = useMutation({
    mutationFn: (connection: Connection) =>
      disconnectChannel(
        connection.anchor.id,
        connection.anchor.delivery_mode === "manual" ? undefined : "connection"
      ),
    onSuccess: () => {
      toast.success("Disconnected");
      setDisconnectTarget(null);
      queryClient.invalidateQueries({ queryKey: ["social-channels"] });
    },
    onError: () => toast.error("Couldn't disconnect. Nothing was changed."),
  });

  const canConnect = can("content:create");

  return (
    <div className="space-y-8">
      {connectFailure && <FailureNotice failure={connectFailure} />}

      {/* What is already connected comes first: it is what a returning person
          came to manage. With nothing connected there is nothing to show, so
          the section is left out and the page opens on the network cards. */}
      {(isLoading || connections.length > 0) && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Connected</h2>
          {isLoading ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-36 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {connections.map((connection) => {
                const { anchor, places, status } = connection;
                const manual = anchor.delivery_mode === "manual";
                const service = serviceOf(anchor.service_id);
                const choosesPlaces = !manual && !!service?.requires_account_id;
                const placeLabel = service?.account_label || "Place";
                // A network that posts as the signed-in account (X) has no
                // places to choose: the connection itself is where it posts.
                const rows = choosesPlaces || manual ? places : [anchor];
                return (
                  <Card key={connection.key}>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="flex items-center gap-1.5 text-base">
                        {anchor.service_name}
                        {manual && (
                          <Badge variant="outline" className="text-xs font-normal">
                            Manual
                          </Badge>
                        )}
                      </CardTitle>
                      <ChannelStatusBadge status={status} />
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {status !== "active" && (
                        <div className="rounded-md bg-muted px-3 py-2 text-sm">
                          <p>{TROUBLE_COPY[status]}</p>
                          {canConnect && !manual && (
                            <Button
                              size="sm"
                              className="mt-2 h-11"
                              disabled={connectMutation.isPending}
                              onClick={() =>
                                connectMutation.mutate({ reconnect_channel_id: anchor.id })
                              }
                            >
                              Reconnect
                            </Button>
                          )}
                        </div>
                      )}

                      {rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Signed in, but it isn&apos;t posting anywhere yet. Choose a{" "}
                          {placeLabel} to start.
                        </p>
                      ) : (
                        <ul className="divide-y rounded-lg border">
                          {rows.map((place) => (
                            <li key={place.id} className="flex items-center gap-3 px-3 py-2">
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {place.account_name || place.account_id || anchor.service_name}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {place.default_target
                                    ? "New posts go here"
                                    : "Only when you choose it for a post"}
                                </span>
                              </span>
                              {can("content:edit") && (
                                <>
                                  <Switch
                                    aria-label={`Post to ${place.account_name || anchor.service_name} by default`}
                                    checked={place.default_target}
                                    disabled={defaultMutation.isPending}
                                    onCheckedChange={(on) =>
                                      defaultMutation.mutate({ id: place.id, on })
                                    }
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-11 w-11"
                                    aria-label={`Rename ${place.account_name || anchor.service_name}`}
                                    onClick={() => setRenameTarget(place)}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {choosesPlaces && can("content:edit") && status === "active" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-11"
                            onClick={() => setPlacesTarget(connection)}
                          >
                            {places.length === 0 ? `Choose ${placeLabel}` : "Change where it posts"}
                          </Button>
                        ) : (
                          <span />
                        )}
                        {can("content:delete") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            // Foreground text with a red icon: the destructive
                            // token as text measures 3.76:1, below AA.
                            className="h-11"
                            onClick={() => setDisconnectTarget(connection)}
                          >
                            <Trash2 className="mr-2 h-4 w-4 text-destructive" aria-hidden />
                            Disconnect
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}


      {canConnect && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {connections.length > 0 ? "Connect another network" : "Connect a network"}
              </h2>
              <p className="text-sm text-muted-foreground">
                Pick a network to sign in to. You&apos;ll choose where it posts next.
              </p>
            </div>
            <Button variant="outline" size="sm" className="h-11" onClick={() => setManualOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add manual channel
            </Button>
          </div>
          <NetworkCards
            services={services}
            connections={connections}
            loading={servicesLoading}
            pendingServiceId={pendingServiceId}
            onPick={(service) => {
              setConnectFailure(null);
              setPendingServiceId(service.service_id);
              connectMutation.mutate({ service_id: service.service_id });
            }}
          />
        </section>
      )}

      <ManualChannelDialog open={manualOpen} onClose={() => setManualOpen(false)} />
      <PlacesDialog
        connection={placesTarget}
        service={placesTarget ? serviceOf(placesTarget.anchor.service_id) : undefined}
        onClose={() => setPlacesTarget(null)}
        reconnecting={connectMutation.isPending}
        onReconnect={(channelId) => connectMutation.mutate({ reconnect_channel_id: channelId })}
      />
      <RenameDialog channel={renameTarget} onClose={() => setRenameTarget(null)} />

      <Dialog
        open={!!disconnectTarget}
        onOpenChange={(o) => !o && setDisconnectTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {disconnectTarget?.anchor.service_name}?</DialogTitle>
            <DialogDescription>
              This removes the sign-in and everywhere it posts. Scheduled posts
              will no longer go to{" "}
              {disconnectTarget && disconnectTarget.places.length > 1
                ? `these ${disconnectTarget.places.length} places`
                : "it"}
              . Posts already published stay where they are.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disconnectMutation.isPending}
              onClick={() => disconnectTarget && disconnectMutation.mutate(disconnectTarget)}
            >
              {disconnectMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
