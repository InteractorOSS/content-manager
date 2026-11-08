"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, FileText, RotateCcw } from "lucide-react";
import { LIST_KEY_STORAGE } from "./writer-api";

// The writer's post list (/write/posts), opened by Claude in the app's browser
// panel through the open_post_list tool, or from the editor's "All posts".
// Links in Claude's chat open in the system browser; clicks inside the panel
// stay there, so a writer picks a post here and the editor opens in the same
// panel.
//
// Authenticated by a browse key from the URL fragment (never sent to a
// server), kept in sessionStorage so the editor's "All posts" link can come
// back without a new one. Opened with no key at all (the editor was opened
// from a plain link), it asks for one with the CMS sign-in.
//
// Tabs: All · Drafts · In review · Published · Trash. Trash lists deleted
// posts, which can be restored (as drafts) for 30 days.

export { LIST_KEY_STORAGE };
const LIST_SEARCH_STORAGE = "interactor-cms-list-search";
const LIST_VIEW_STORAGE = "interactor-cms-list-view";

const VIEWS = [
  { id: "all", label: "All" },
  { id: "drafts", label: "Drafts" },
  { id: "review", label: "In review" },
  { id: "published", label: "Published" },
  { id: "trash", label: "Trash" },
] as const;
type View = (typeof VIEWS)[number]["id"];

type ListPost = {
  id: string;
  title: string;
  excerpt: string | null;
  status: string;
  workflow_status: string;
  platforms: string[];
  content_format: string;
  featured_image: string | null;
  updated_at: string;
};

type TrashEntry = {
  id: string;
  post_id: string;
  title: string;
  status: string;
  platforms: string[];
  deleted_at: string;
  deleted_by: string | null;
  expires_at: string;
};

type ListData = {
  account: string;
  organization: string;
  site: string | null;
  view: View;
  counts: Record<View, number>;
  can_restore: boolean;
  posts: ListPost[];
  trash: TrashEntry[];
};

function storage(action: (s: Storage) => void) {
  try {
    action(sessionStorage);
  } catch {
    /* storage unavailable */
  }
}

function readListKey(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1)).get("key");
  if (hash) {
    storage((s) => s.setItem(LIST_KEY_STORAGE, hash));
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return hash;
  }
  let stored: string | null = null;
  storage((s) => (stored = s.getItem(LIST_KEY_STORAGE)));
  return stored;
}

/** A list key from the CMS sign-in, or a redirect to sign in. */
async function listKeyFromSignIn(): Promise<{ key: string } | { error: string } | { redirecting: true }> {
  const res = await fetch("/api/edit/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ list: true }),
  }).catch(() => null);
  if (!res) return { error: "Couldn't reach the CMS." };
  if (res.status === 401) {
    window.location.href = `/login?callbackUrl=${encodeURIComponent("/write/posts")}`;
    return { redirecting: true };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error ?? `Couldn't load your posts (${res.status}).` };
  return { key: body.data.list_key as string };
}

function statusLabel(p: { status: string; workflow_status: string }): { text: string; tone: string } {
  if (p.status === "published") return { text: "Published", tone: "bg-emerald-50 text-emerald-700" };
  if (p.workflow_status === "pending_review") return { text: "In review", tone: "bg-amber-50 text-amber-700" };
  if (p.workflow_status === "rejected") return { text: "Changes requested", tone: "bg-red-50 text-red-700" };
  return { text: "Draft", tone: "bg-gray-100 text-gray-700" };
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function PostList() {
  const keyRef = useRef<string | null>(null);
  const [data, setData] = useState<ListData | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (q: string, v: View) => {
    if (!keyRef.current) return;
    setLoading(true);
    const params = new URLSearchParams({ view: v, ...(q && { search: q }) });
    const res = await fetch(`/api/edit/posts?${params}`, {
      headers: { Authorization: `Bearer ${keyRef.current}` },
      cache: "no-store",
    }).catch(() => null);
    setLoading(false);
    if (!res) return setError("Couldn't reach the CMS.");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? `Couldn't load posts (${res.status}).`);
    setError("");
    setData(body.data as ListData);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      keyRef.current = readListKey();
      if (!keyRef.current) {
        const got = await listKeyFromSignIn();
        if (cancelled || "redirecting" in got) return;
        if ("error" in got) {
          setLoading(false);
          setError(got.error);
          return;
        }
        keyRef.current = got.key;
        storage((s) => s.setItem(LIST_KEY_STORAGE, got.key));
      }
      let initial = new URLSearchParams(window.location.search).get("q") ?? "";
      let initialView: View = "all";
      storage((s) => {
        if (!initial) initial = s.getItem(LIST_SEARCH_STORAGE) ?? "";
        const v = s.getItem(LIST_VIEW_STORAGE);
        if (VIEWS.some((x) => x.id === v)) initialView = v as View;
      });
      setSearch(initial);
      setView(initialView);
      setReady(true);
    })();
    // A new #key= (Claude reopening the list) is a fragment-only navigation.
    const onHash = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).get("key")) window.location.reload();
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  // Reload on a new tab or search, the search briefly debounced.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => void load(search.trim(), view), 300);
    return () => clearTimeout(t);
  }, [ready, search, view, load]);

  // Remembered only when the writer changes them, so "All posts" comes back
  // to the same place (saving from an effect overwrote them with the empty
  // initial values before they could be restored).
  const onSearch = (value: string) => {
    setSearch(value);
    storage((s) => s.setItem(LIST_SEARCH_STORAGE, value));
  };
  const onView = (value: View) => {
    setView(value);
    storage((s) => s.setItem(LIST_VIEW_STORAGE, value));
  };

  const openPost = async (postId: string) => {
    const res = await fetch("/api/edit/open", {
      method: "POST",
      headers: { Authorization: `Bearer ${keyRef.current}`, "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res || !res.ok) {
      setBusy(null);
      setError(body?.error ?? "Couldn't open that post.");
      return;
    }
    window.location.href = `/write#key=${body.data.edit_key}`;
  };

  const open = (post: ListPost) => {
    setBusy(post.id);
    void openPost(post.id);
  };

  const restore = async (entry: TrashEntry) => {
    setBusy(entry.id);
    const res = await fetch("/api/edit/restore", {
      method: "POST",
      headers: { Authorization: `Bearer ${keyRef.current}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res || !res.ok) {
      setBusy(null);
      setError(body?.error ?? "Couldn't restore that post.");
      return;
    }
    // Restored as a draft: open it straight away.
    storage((s) => s.setItem(LIST_VIEW_STORAGE, "all"));
    await openPost(body.data.id);
  };

  const empty =
    data && !loading && (view === "trash" ? data.trash.length === 0 : data.posts.length === 0)
      ? search
        ? "No posts match that search."
        : view === "trash"
          ? "The trash is empty. Deleted posts stay here for 30 days."
          : view === "all"
            ? "No posts yet. Ask Claude to start one."
            : "Nothing here."
      : null;

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-[760px] px-4 pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-lg font-semibold">Posts</h1>
            <span className="truncate text-xs text-gray-500" title="Account · organization · site">
              {data && [data.account, data.organization, data.site ?? "all sites"].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-gray-300 px-2">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search titles and text"
              aria-label="Search posts"
              className="w-full py-1.5 text-sm outline-none"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          <nav className="-mb-px mt-2 flex gap-1 overflow-x-auto" aria-label="Filter posts">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onView(v.id)}
                aria-current={view === v.id ? "page" : undefined}
                className={`shrink-0 border-b-2 px-2.5 py-2 text-sm ${
                  view === v.id ? "border-gray-900 font-medium text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                {v.label}
                {data && <span className="ml-1 text-xs text-gray-400">{data.counts[v.id]}</span>}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-4 pb-16 pt-2">
        {error && <p className="my-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {empty && <p className="my-10 text-center text-sm text-gray-500">{empty}</p>}

        {view !== "trash" && (
          <ul className="divide-y divide-gray-100">
            {data?.posts.map((p) => {
              const status = statusLabel(p);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => open(p)}
                    disabled={busy !== null}
                    className="flex w-full items-start gap-3 px-1 py-3 text-left hover:bg-gray-50 disabled:opacity-60"
                  >
                    {p.featured_image ? (
                      <img src={p.featured_image} alt="" className="mt-0.5 h-10 w-16 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="mt-0.5 flex h-10 w-16 shrink-0 items-center justify-center rounded bg-gray-50">
                        <FileText className="h-4 w-4 text-gray-300" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-snug">{p.title || "Untitled"}</span>
                      {p.excerpt && <span className="mt-0.5 line-clamp-1 block text-sm text-gray-500">{p.excerpt}</span>}
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span className={`rounded px-1.5 py-0.5 ${status.tone}`}>{status.text}</span>
                        <span>{p.platforms.join(", ")}</span>
                        <span>Updated {when(p.updated_at)}</span>
                      </span>
                    </span>
                    {busy === p.id && <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-gray-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {view === "trash" && (
          <ul className="divide-y divide-gray-100">
            {data?.trash.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-1 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium leading-snug text-gray-700">{t.title || "Untitled"}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5">
                      Was {t.status === "published" ? "published" : "a draft"}
                    </span>
                    <span>{t.platforms.join(", ")}</span>
                    <span>
                      Deleted {when(t.deleted_at)}
                      {t.deleted_by ? ` by ${t.deleted_by}` : ""}
                    </span>
                    <span>Gone for good {when(t.expires_at)}</span>
                  </span>
                </span>
                {data.can_restore && (
                  <button
                    type="button"
                    onClick={() => void restore(t)}
                    disabled={busy !== null}
                    title="Restore as a draft and open it"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-60"
                  >
                    {busy === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
