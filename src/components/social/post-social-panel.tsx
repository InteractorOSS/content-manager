"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { partSupportForNetwork } from "@/lib/social/capabilities";
import { splitPartsText } from "@/lib/social/parts";
import {
  DRAFT_LIMITS,
  DRAFT_NETWORK_LABELS,
  DRAFT_NETWORKS,
  type DraftNetwork,
} from "@/lib/social/destinations";

// A post's social copy and where it goes: one draft per network, the places
// each network's copy is posted to, and the link it carries back to the post.
//
// Used by both editors. The writer editor (/write) reaches the post with its
// edit key through /api/edit/social*; the CMS post editor uses the signed-in
// session through /api/cms/posts/[id]/social*. The two pairs of routes answer
// in the same shape, so the only thing that differs here is the URLs and the
// headers.

const inputClass = "w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-gray-500";


type SocialNetwork = DraftNetwork;

type SocialDraft = {
  id: string;
  network: SocialNetwork;
  body: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  editable: boolean;
};

/** One place this post's copy can go (src/lib/post-social-delivery.ts). */
type Destination = {
  id: string;
  network: SocialNetwork;
  service_name: string;
  account_name: string | null;
  /** "trouble": the connection needs reconnecting; shown greyed out. */
  state: "ready" | "trouble";
  /** A person posts this one by hand from the manual queue. */
  manual: boolean;
  selected: boolean;
  is_default: boolean;
};

type Delivery = { destinations: Destination[]; overridden: boolean; backlink: string | null };

const SOCIAL_POLL_MS = 3000;

export function PostSocialPanel({
  draftsUrl,
  placesUrl,
  headers,
  readOnly,
}: {
  /** GET → the drafts; PUT { network, body } saves one. */
  draftsUrl: string;
  /** GET → the destinations; PUT { channel_ids } saves this post's choice. */
  placesUrl: string;
  /** Sent with every request (the writer editor's edit key; none for a session). */
  headers?: Record<string, string>;
  readOnly: boolean;
}) {
  // Callers pass a fresh object each render; key on its contents so the poll
  // below isn't restarted every time the parent re-renders.
  const headerKey = JSON.stringify(headers ?? {});
  const auth = useMemo(() => JSON.parse(headerKey) as Record<string, string>, [headerKey]);
  const [drafts, setDrafts] = useState<Partial<Record<SocialNetwork, SocialDraft>>>({});
  const [text, setText] = useState<Partial<Record<SocialNetwork, string>>>({});
  const [state, setState] = useState<Partial<Record<SocialNetwork, "saving" | "saved" | "error">>>({});
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [savingPlaces, setSavingPlaces] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Networks the writer has typed in and not yet saved: a poll never
  // overwrites those.
  const dirtyRef = useRef(new Set<SocialNetwork>());
  const timers = useRef<Partial<Record<SocialNetwork, ReturnType<typeof setTimeout>>>>({});
  // A poll that started before a destination change must not put the old
  // selection back on screen.
  const placesBusyRef = useRef(false);

  const load = useCallback(async () => {
    const [draftsRes, placesRes] = await Promise.all([
      fetch(draftsUrl, { headers: auth, cache: "no-store" }).catch(() => null),
      fetch(placesUrl, { headers: auth, cache: "no-store" }).catch(() => null),
    ]);
    if (placesRes?.ok && !placesBusyRef.current) {
      setDelivery((await placesRes.json()).data as Delivery);
    }
    if (!draftsRes?.ok) return;
    const list = (await draftsRes.json()).data as SocialDraft[];
    const byNetwork: Partial<Record<SocialNetwork, SocialDraft>> = {};
    for (const d of list) byNetwork[d.network] = d;
    setDrafts(byNetwork);
    setText((prev) => {
      const next = { ...prev };
      for (const n of DRAFT_NETWORKS) if (!dirtyRef.current.has(n)) next[n] = byNetwork[n]?.body ?? "";
      return next;
    });
    setLoaded(true);
  }, [draftsUrl, placesUrl, auth]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), SOCIAL_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const save = async (network: SocialNetwork, body: string) => {
    setState((s) => ({ ...s, [network]: "saving" }));
    const res = await fetch(draftsUrl, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ network, body }),
    }).catch(() => null);
    if (!res?.ok) {
      const err = await res?.json().catch(() => ({}));
      setError(err?.error ?? "Couldn't save the social copy.");
      setState((s) => ({ ...s, [network]: "error" }));
      return;
    }
    setError("");
    const saved = (await res.json()).data as SocialDraft | null;
    setDrafts((d) => ({ ...d, [network]: saved ?? undefined }));
    // Still the text on screen? Then this network is clean again.
    setText((t) => {
      if ((t[network] ?? "") === body) dirtyRef.current.delete(network);
      return t;
    });
    setState((s) => ({ ...s, [network]: "saved" }));
  };

  const onChange = (network: SocialNetwork, value: string) => {
    dirtyRef.current.add(network);
    setText((t) => ({ ...t, [network]: value }));
    clearTimeout(timers.current[network]);
    timers.current[network] = setTimeout(() => void save(network, value), 1000);
  };

  // Save this post's own choice of places; null goes back to the channels'
  // defaults. The switch flips at once and is put back if the save fails.
  const savePlaces = async (channelIds: string[] | null, optimistic: Delivery | null) => {
    const before = delivery;
    placesBusyRef.current = true;
    setSavingPlaces(true);
    if (optimistic) setDelivery(optimistic);
    const res = await fetch(placesUrl, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_ids: channelIds }),
    }).catch(() => null);
    if (res?.ok) {
      setDelivery((await res.json()).data as Delivery);
      setError("");
    } else {
      const err = await res?.json().catch(() => ({}));
      setDelivery(before);
      setError(err?.error ?? "Couldn't save where this post goes. Nothing was changed.");
    }
    placesBusyRef.current = false;
    setSavingPlaces(false);
  };

  const togglePlace = (destination: Destination, on: boolean) => {
    if (!delivery) return;
    const next = delivery.destinations.map((d) => (d.id === destination.id ? { ...d, selected: on } : d));
    void savePlaces(
      next.filter((d) => d.selected).map((d) => d.id),
      { ...delivery, destinations: next, overridden: true }
    );
  };

  if (!loaded) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading social copy…
      </p>
    );
  }

  const destinations = delivery?.destinations ?? [];
  // A network is shown when this organization can post to it, or when copy
  // was already written for it (so nothing written ever disappears).
  const networks = DRAFT_NETWORKS.filter(
    (n) => destinations.some((d) => d.network === n) || drafts[n] || (text[n] ?? "") !== ""
  );

  return (
    <div>
      <p className="mb-3 text-xs text-gray-500">
        One draft per network, saved as you type. Ask Claude to write them (&ldquo;write the LinkedIn post for this&rdquo;).
        Schedule and publish them from the CMS&apos;s Social queue.
      </p>

      <p className="mb-4 rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-600">
        {delivery?.backlink ? (
          <>
            Each one links back to this post:{" "}
            <span className="break-all font-medium text-gray-800">{delivery.backlink}</span>
          </>
        ) : (
          "No link back to this post yet: it has no public address. Choose a site for it in Details."
        )}
      </p>

      {error && <p className="mb-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}

      {destinations.length === 0 && (
        <p className="mb-4 text-xs text-gray-500">
          Nothing is connected yet, so copy written here has nowhere to go.{" "}
          <a href="/social/channels" target="_blank" rel="noreferrer" className="underline">
            Connect a network
          </a>
          .
        </p>
      )}

      {delivery?.overridden && !readOnly && (
        <p className="mb-4 text-xs text-gray-500">
          This post has its own choice of where to post.{" "}
          <button
            type="button"
            className="underline disabled:opacity-50"
            disabled={savingPlaces}
            onClick={() => void savePlaces(null, null)}
          >
            Use the usual places
          </button>
        </p>
      )}

      {networks.map((n) => {
        const draft = drafts[n];
        const value = text[n] ?? "";
        const locked = draft && !draft.editable;
        const limit = DRAFT_LIMITS[n];
        // Measured the way the copy is saved: split into the post, its thread
        // and its first comment (src/lib/social/parts.ts). On X each tweet,
        // the comment included, has the limit to itself.
        const support = partSupportForNetwork(n);
        const split = splitPartsText(value, support);
        const longest = support.threads
          ? Math.max(split.body.length, ...split.parts.map((p) => p.body.length))
          : split.body.length;
        const tweets = 1 + split.parts.filter((p) => p.kind === "thread").length;
        const hint = support.threads
          ? "A line with only --- starts the next tweet of a thread. A line --- first comment starts a reply posted after the last tweet."
          : support.firstComment
            ? "A line --- first comment starts a comment we post under the post once it's live."
            : null;
        const places = destinations.filter((d) => d.network === n);
        const goesSomewhere = places.some((d) => d.selected);
        // The box is for networks this post goes to. Copy already written for
        // a network that was switched off stays visible, so it isn't lost.
        const showInput = goesSomewhere || value !== "" || !!draft;
        return (
          <div key={n} className="mb-5">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <span className="font-medium uppercase tracking-wide text-gray-500">{DRAFT_NETWORK_LABELS[n]}</span>
              {draft && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">{draft.status.replace(/_/g, " ")}</span>}
              <span className="ml-auto text-gray-400">
                {state[n] === "saving" ? "Saving…" : state[n] === "saved" ? "Saved" : ""}
              </span>
            </div>

            {places.length > 0 ? (
              <ul className="mb-2 space-y-1">
                {places.map((d) => {
                  const trouble = d.state === "trouble";
                  return (
                    <li key={d.id}>
                      <label
                        className={`flex items-center gap-2 text-xs ${
                          trouble ? "cursor-not-allowed text-gray-400" : "cursor-pointer text-gray-700"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={d.selected}
                          disabled={readOnly || trouble || savingPlaces}
                          onChange={(e) => togglePlace(d, e.target.checked)}
                        />
                        <span className="truncate">{d.account_name || d.service_name}</span>
                        {d.manual && <span className="shrink-0 text-gray-400">· you post this one yourself</span>}
                        {trouble && <span className="shrink-0">· needs reconnecting in Social → Channels</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mb-2 text-xs text-gray-400">
                Not connected, so this copy has nowhere to go yet.
              </p>
            )}

            {locked && (
              <p className="mb-1 text-xs text-gray-500">
                Already {draft.status}. Typing here starts a new draft; the published copy stays as it went out.
              </p>
            )}
            {showInput ? (
              <>
                <textarea
                  value={value}
                  readOnly={readOnly}
                  onChange={(e) => onChange(n, e.target.value)}
                  // A thread gets the room a LinkedIn post has, so more than its first tweet shows.
                  rows={n === "linkedin" || tweets > 1 ? 7 : 4}
                  aria-describedby={hint ? `social-hint-${n}` : undefined}
                  placeholder={
                    n === "twitter"
                      ? "One tweet, or a thread"
                      : n === "reddit"
                        ? "First line is the post title. The rest is the body."
                        : `Write the ${DRAFT_NETWORK_LABELS[n]} post`
                  }
                  className={inputClass}
                />
                <div className="mt-0.5 flex items-start gap-3 text-xs">
                  {hint && (
                    <span id={`social-hint-${n}`} className="text-gray-500">
                      {hint}
                    </span>
                  )}
                  <span className={`ml-auto shrink-0 tabular-nums ${longest > limit ? "text-red-600" : "text-gray-500"}`}>
                    {longest}/{limit}
                    {support.threads ? (tweets > 1 ? ` per tweet · ${tweets} tweets` : " per tweet") : ""}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-400">Tick a place above to write copy for it.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
