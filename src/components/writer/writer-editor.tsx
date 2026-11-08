"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, AlertTriangle, SlidersHorizontal, Share2 } from "lucide-react";
import { mergeEdits } from "@/lib/writer-editor/markdown";
import { PostDrawer, type DrawerTab } from "./post-drawer";
import { MarkdownContentEditor } from "./markdown-content-editor";
import {
  altFromFilename,
  storeListKeyFromHash,
  uploadImage,
  type WriterDetails,
  type WriterOptions,
} from "./writer-api";

// The writer editor (/write): the post, formatted, typed on directly — the
// editable counterpart of the read-only /preview page that the Interactor
// Writing plugin used to open beside the chat.
//
// It is one more client of the post's editing session (the same one-post
// edit key the plugin's local sync tool holds), talking to /api/edit/doc.
// The text itself is edited in MarkdownContentEditor, the same component the
// CMS post editor uses; this page adds the live session around it. Three
// things keep it honest alongside Claude editing the same post through the
// local file:
//   - It saves only the writer's edits, patched onto the original Markdown
//     (the editor component's rule): the editor's own re-serialization never
//     reaches the CMS, and a post opened but not edited is never written.
//   - It polls for changes made elsewhere and applies them only while the
//     writer is idle, so the cursor never jumps mid-sentence.
//   - When both sides changed, non-overlapping edits merge on their own
//     (mergeEdits); an overlapping one stops and asks.
//
// Two ways in:
//   - /write#key=<edit key>: what Claude opens beside the chat. The key rides
//     in the fragment, which browsers never send to a server, and moves into
//     sessionStorage so it leaves the address bar.
//   - /write?post=<id>: a plain link (post lists, the CMS's posts table), no
//     secret in it. The page asks /api/edit/session for a key using the CMS
//     sign-in, sending a signed-out writer to sign in and straight back.

const KEY_STORAGE = "interactor-cms-edit-key";
const SAVE_DEBOUNCE_MS = 1000;
const POLL_MS = 2000;
const IDLE_MS = 1500;

type Doc = {
  version: string;
  account: string;
  organization: string;
  title: string;
  excerpt: string;
  body: string;
  content_format: string;
  slug: string;
  status: string;
  workflow_status: string;
  platforms: string[];
  details: WriterDetails;
  post_id: string;
};

const EMPTY_DETAILS: WriterDetails = {
  slug: "",
  category: "",
  tags: [],
  platforms: [],
  featured_image: "",
  featured_image_alt: "",
  meta_description: "",
  meta_keywords: "",
};

/** The Details fields that differ from what was last saved. */
function changedDetails(current: WriterDetails, saved: WriterDetails): Partial<WriterDetails> {
  const out: Partial<WriterDetails> = {};
  for (const key of Object.keys(current) as (keyof WriterDetails)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(saved[key])) (out as Record<string, unknown>)[key] = current[key];
  }
  return out;
}

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";
type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "ended"; message: string } | { kind: "html" };
type Conflict = { theirs: Doc; mine: string };

/**
 * An edit key for /write?post=<id>, from the CMS sign-in. Redirects to sign-in
 * (and back here) when signed out; returns an error message when this
 * account can't open the post.
 */
async function keyFromSignIn(postId: string): Promise<{ key: string } | { error: string } | { redirecting: true }> {
  const res = await fetch("/api/edit/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ post_id: postId }),
  }).catch(() => null);
  if (!res) return { error: "Couldn't reach the CMS." };
  if (res.status === 401) {
    const back = window.location.pathname + window.location.search;
    window.location.href = `/login?callbackUrl=${encodeURIComponent(back)}`;
    return { redirecting: true };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error ?? `Couldn't open the post (${res.status}).` };
  return { key: body.data.edit_key as string };
}

function readKey(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1)).get("key");
  storeListKeyFromHash();
  try {
    if (hash) {
      sessionStorage.setItem(KEY_STORAGE, hash);
      window.history.replaceState(null, "", window.location.pathname);
      return hash;
    }
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return hash;
  }
}

function statusLabel(doc: Doc): string {
  if (doc.status === "published") return "Published";
  if (doc.workflow_status === "pending_review") return "Draft · in review";
  if (doc.workflow_status === "rejected") return "Draft · changes requested";
  return "Draft";
}

export function WriterEditor() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [title, setTitle] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [details, setDetails] = useState<WriterDetails>(EMPTY_DETAILS);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [options, setOptions] = useState<WriterOptions | null>(null);
  // The body as the editor has it (the writer's edits on the saved text) and
  // the header element its toolbar renders into.
  const [body, setBody] = useState("");
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);

  const keyRef = useRef<string | null>(null);
  // The body as the CMS has it, and the version it belongs to.
  const savedBodyRef = useRef("");
  const bodyRef = useRef("");
  const versionRef = useRef("");
  const savedTitleRef = useRef("");
  const savedExcerptRef = useRef("");
  const savedDetailsRef = useRef<WriterDetails>(EMPTY_DETAILS);
  const titleRef = useRef("");
  const excerptRef = useRef("");
  const detailsRef = useRef<WriterDetails>(EMPTY_DETAILS);
  const lastInputRef = useRef(0);
  const busyRef = useRef(false);
  const conflictRef = useRef<Conflict | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  titleRef.current = title;
  excerptRef.current = excerpt;
  detailsRef.current = details;
  conflictRef.current = conflict;

  const api = useCallback(async (method: "GET" | "PUT", headers: Record<string, string> = {}, body?: unknown) => {
    return fetch("/api/edit/doc", {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${keyRef.current}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }, []);

  // Set when the session ends while the writer still has unsaved changes: the
  // page then stays up, read-only, so those words can be copied rather than
  // vanishing with it.
  const [endedUnsaved, setEndedUnsaved] = useState(false);
  const endedRef = useRef(false);

  const endSession = useCallback(async (res: Response) => {
    let message = "This editing session has ended.";
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* not JSON */
    }
    endedRef.current = true;
    const unsaved =
      bodyRef.current !== savedBodyRef.current ||
      titleRef.current !== savedTitleRef.current ||
      excerptRef.current !== savedExcerptRef.current ||
      Object.keys(changedDetails(detailsRef.current, savedDetailsRef.current)).length > 0;
    if (unsaved) {
      // The editor goes read-only (endedUnsaved), keeping the words to copy.
      setEndedUnsaved(true);
      setSaveError("Not saved: session ended");
      setSaveState("error");
      return;
    }
    setPhase({ kind: "ended", message });
  }, []);

  const isDirty = useCallback(
    () =>
      bodyRef.current !== savedBodyRef.current ||
      titleRef.current !== savedTitleRef.current ||
      excerptRef.current !== savedExcerptRef.current ||
      Object.keys(changedDetails(detailsRef.current, savedDetailsRef.current)).length > 0,
    []
  );

  /** Put a version from the CMS into the page (the editor reloads, keeping
   *  the scroll position). */
  const loadDoc = useCallback((next: Doc) => {
    setDoc(next);
    versionRef.current = next.version;
    savedBodyRef.current = next.body;
    bodyRef.current = next.body;
    setBody(next.body);
    savedTitleRef.current = next.title;
    savedExcerptRef.current = next.excerpt;
    savedDetailsRef.current = next.details;
    detailsRef.current = next.details;
    setTitle(next.title);
    setExcerpt(next.excerpt);
    setDetails(next.details);
    setSaveState("saved");
  }, []);

  const save = useCallback(async () => {
    if (endedRef.current) return;
    if (busyRef.current || conflictRef.current || !isDirty()) {
      if (!isDirty()) setSaveState("saved");
      return;
    }
    busyRef.current = true;
    setSaveState("saving");
    const body = bodyRef.current;
    try {
      const res = await api(
        "PUT",
        { "If-Match": `"${versionRef.current}"` },
        {
          title: titleRef.current,
          excerpt: excerptRef.current,
          body,
          details: changedDetails(detailsRef.current, savedDetailsRef.current),
        }
      );
      if (res.status === 401) return endSession(res);
      if (res.status === 409) {
        const err = await res.clone().json().catch(() => ({}));
        if (!err.version) {
          // Not a version race: the CMS refused the change itself (a slug
          // another post already uses, say). Say so and wait for a fix.
          setSaveError(err.error ?? "The CMS refused this change.");
          setSaveState("error");
          return;
        }
        busyRef.current = false;
        setSaveState("unsaved");
        void poll(true);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError(err.error ?? `Couldn't save (${res.status})`);
        setSaveState("error");
        return;
      }
      const saved = (await res.json()).data as Doc;
      setDoc(saved);
      versionRef.current = saved.version;
      savedBodyRef.current = saved.body;
      // The CMS stored something other than what was sent, and nothing was
      // typed since: show what it stored.
      if (saved.body !== body && bodyRef.current === body) {
        bodyRef.current = saved.body;
        setBody(saved.body);
      }
      savedTitleRef.current = saved.title;
      savedExcerptRef.current = saved.excerpt;
      savedDetailsRef.current = saved.details;
      setSaveError("");
      setSaveState(isDirty() ? "unsaved" : "saved");
      if (isDirty()) scheduleSave();
    } catch {
      setSaveError("Offline — will retry");
      setSaveState("error");
      scheduleSave();
    } finally {
      busyRef.current = false;
    }
    // poll and scheduleSave are stable callbacks declared below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, endSession, isDirty]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }, [save]);

  const onInput = useCallback(() => {
    lastInputRef.current = Date.now();
    setSaveState("unsaved");
    scheduleSave();
  }, [scheduleSave]);

  /** Pick up changes made elsewhere (Claude editing the file, the CMS). */
  const poll = useCallback(
    async (force = false) => {
      if (!keyRef.current || endedRef.current || busyRef.current || conflictRef.current) return;
      const idle = Date.now() - lastInputRef.current > IDLE_MS;
      if (!force && !idle) return;
      busyRef.current = true;
      try {
        const res = await api("GET", { "If-None-Match": `"${versionRef.current}"` });
        if (res.status === 401) return endSession(res);
        if (res.status !== 200) return;
        const theirs = (await res.json()).data as Doc;
        if (theirs.version === versionRef.current) return;

        if (!isDirty()) {
          loadDoc(theirs);
          setNotice("Updated with a change made outside this page.");
          return;
        }
        const mine = bodyRef.current;
        const merged = mergeEdits(savedBodyRef.current, mine, theirs.body);
        if (!merged.clean) {
          setConflict({ theirs, mine });
          setSaveState("conflict");
          return;
        }
        const res2 = await api(
          "PUT",
          { "If-Match": `"${theirs.version}"` },
          {
            title: titleRef.current !== savedTitleRef.current ? titleRef.current : theirs.title,
            excerpt: excerptRef.current !== savedExcerptRef.current ? excerptRef.current : theirs.excerpt,
            body: merged.text,
            // Only the Details the writer changed here; theirs stand otherwise.
            details: changedDetails(detailsRef.current, savedDetailsRef.current),
          }
        );
        if (res2.status === 401) return endSession(res2);
        if (res2.ok) {
          loadDoc((await res2.json()).data as Doc);
          setNotice("Merged your edits with a change made outside this page.");
        }
      } catch {
        /* offline; try again next tick */
      } finally {
        busyRef.current = false;
      }
    },
    [api, endSession, isDirty, loadDoc]
  );

  const resolveConflict = useCallback(
    async (choice: "mine" | "theirs") => {
      const c = conflictRef.current;
      if (!c) return;
      if (choice === "theirs") {
        setConflict(null);
        loadDoc(c.theirs);
        return;
      }
      busyRef.current = true;
      try {
        const res = await api(
          "PUT",
          { "If-Match": `"${c.theirs.version}"` },
          {
            title: titleRef.current,
            excerpt: excerptRef.current,
            body: c.mine,
            details: changedDetails(detailsRef.current, savedDetailsRef.current),
          }
        );
        if (res.status === 401) return endSession(res);
        if (res.ok) {
          setConflict(null);
          loadDoc((await res.json()).data as Doc);
        } else if (res.status === 409) {
          setConflict(null);
          busyRef.current = false;
          void poll(true);
        }
      } finally {
        busyRef.current = false;
      }
    },
    [api, endSession, loadDoc, poll]
  );

  // First load: get a key (from the link, or from the CMS sign-in for a
  // ?post= link), then fetch the post.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const postParam = new URLSearchParams(window.location.search).get("post");
      const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("key");
      if (postParam && !fromHash) {
        const got = await keyFromSignIn(postParam);
        if (cancelled || "redirecting" in got) return;
        if ("error" in got) return setPhase({ kind: "ended", message: got.error });
        keyRef.current = got.key;
      } else {
        keyRef.current = readKey();
      }
      if (!keyRef.current) {
        setPhase({ kind: "ended", message: "This link doesn't carry an editing session. Ask Claude to open the post again." });
        return;
      }
      const res = await api("GET").catch(() => null);
      if (cancelled) return;
      if (!res) return setPhase({ kind: "ended", message: "Couldn't reach the CMS." });
      if (res.status === 401) return endSession(res);
      if (!res.ok) return setPhase({ kind: "ended", message: `Couldn't open the post (${res.status}).` });
      const first = (await res.json()).data as Doc;
      setDoc(first);
      if (first.content_format !== "markdown") return setPhase({ kind: "html" });
      loadDoc(first);
      setPhase({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
    // Runs once; the callbacks it uses are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opening the next post (or reopening this one) points the same tab at
  // /write#key=<new key>. Only the fragment changes, which browsers treat as
  // an in-page jump, not a load — so without this the tab kept showing the
  // previous session, often "ended".
  useEffect(() => {
    const onHash = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).get("key")) window.location.reload();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (phase.kind !== "ready") return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase.kind, poll]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // What the Details panel offers (categories, sites, tags) and may do.
  useEffect(() => {
    if (phase.kind !== "ready" || !keyRef.current) return;
    fetch("/api/edit/options", { headers: { Authorization: `Bearer ${keyRef.current}` }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b && setOptions(b.data as WriterOptions))
      .catch(() => {});
  }, [phase.kind]);

  const onDetails = useCallback(
    (patch: Partial<WriterDetails>) => {
      setDetails((d) => {
        const next = { ...d, ...patch };
        detailsRef.current = next;
        return next;
      });
      onInput();
    },
    [onInput]
  );

  const upload = useCallback(async (file: File) => {
    const alt = altFromFilename(file.name);
    const img = await uploadImage(keyRef.current ?? "", file, alt);
    return { url: img.url, alt: img.alt_text ?? alt };
  }, []);
  const onImageError = useCallback((message: string) => {
    setSaveError(message);
    setSaveState("error");
  }, []);
  const onBody = useCallback(
    (markdown: string) => {
      bodyRef.current = markdown;
      setBody(markdown);
      onInput();
    },
    [onInput]
  );

  const moveToTrash = async () => {
    if (!keyRef.current) return;
    if (!window.confirm("Move this post to the trash? You can restore it from the post list for 30 days.")) return;
    const res = await fetch("/api/edit/doc", { method: "DELETE", headers: { Authorization: `Bearer ${keyRef.current}` } }).catch(
      () => null
    );
    if (!res || !res.ok) {
      const err = await res?.json().catch(() => ({}));
      setSaveError(err?.error ?? "Couldn't move the post to the trash.");
      setSaveState("error");
      return;
    }
    endedRef.current = true;
    window.location.href = "/write/posts";
  };

  if (phase.kind === "loading") {
    return <Centered>Opening the post…</Centered>;
  }
  if (phase.kind === "ended") {
    return (
      <Centered>
        <p className="font-medium text-foreground">{phase.message}</p>
        <p className="mt-2">Everything you typed had already been saved to the CMS.</p>
      </Centered>
    );
  }
  if (phase.kind === "html") {
    return (
      <Centered>
        <p className="font-medium text-foreground">{doc?.title}</p>
        <p className="mt-2">
          This post is stored as HTML, which this editor can&apos;t edit. Open it in the CMS editor, or ask Claude to make
          the change.
        </p>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 px-4 py-2 text-xs text-gray-500">
          <a href="/write/posts" className="shrink-0 text-gray-700 hover:text-gray-900" title="Your other posts">
            ← All posts
          </a>
          <span className="min-w-0 flex-1 truncate" title="Account · organization · status · sites">
            {doc && [doc.account, doc.organization, statusLabel(doc), doc.platforms.join(", ")].filter(Boolean).join(" · ")}
          </span>
          <SaveIndicator state={saveState} error={saveError} />
          <button
            type="button"
            onClick={() => setDrawer((d) => (d === "details" ? null : "details"))}
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-gray-100 ${drawer === "details" ? "bg-gray-100 text-gray-900" : "text-gray-700"}`}
            title="Featured image, URL, category, tags, sites, search description"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Details
          </button>
          <button
            type="button"
            onClick={() => setDrawer((d) => (d === "social" ? null : "social"))}
            className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-gray-100 ${drawer === "social" ? "bg-gray-100 text-gray-900" : "text-gray-700"}`}
            title="LinkedIn, X and Facebook copy for this post"
          >
            <Share2 className="h-3.5 w-3.5" /> Social
          </button>
        </div>
        {/* The editor's toolbar renders here, in the sticky header. */}
        <div ref={setToolbarEl} className="mx-auto max-w-[760px]" />
      </header>

      {endedUnsaved && (
        <div className="mx-auto mt-4 max-w-[760px] px-4">
          <div className="flex items-start gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This editing session ended before your latest changes were saved. Copy anything you need from the page
              below, then ask Claude to open the post again and paste it back in.
            </span>
          </div>
        </div>
      )}
      {conflict && (
        <div className="mx-auto mt-4 max-w-[760px] px-4">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              This post changed outside this page while you were editing the same part. Which version should stay?
            </span>
            <button onClick={() => void resolveConflict("mine")} className="rounded bg-amber-900 px-3 py-1 text-white">
              Keep mine
            </button>
            <button onClick={() => void resolveConflict("theirs")} className="rounded border border-amber-900 px-3 py-1">
              Use the new version
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div className="mx-auto mt-3 max-w-[760px] px-4 text-xs text-emerald-700" role="status">
          {notice}
        </div>
      )}

      <main className="mx-auto max-w-[760px] px-4 pb-24 pt-6">
        {details.featured_image && (
          <button
            type="button"
            onClick={() => setDrawer("details")}
            title="Featured image: change it in Details"
            className="mb-5 block w-full overflow-hidden rounded-md"
          >
            <img src={details.featured_image} alt={details.featured_image_alt} className="aspect-[1200/630] w-full object-cover" />
          </button>
        )}
        <textarea
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            onInput();
          }}
          rows={1}
          readOnly={endedUnsaved}
          placeholder="Title"
          aria-label="Title"
          className="w-full resize-none border-none bg-transparent text-3xl font-bold leading-tight outline-none [field-sizing:content]"
        />
        <textarea
          value={excerpt}
          onChange={(e) => {
            setExcerpt(e.target.value);
            onInput();
          }}
          rows={1}
          readOnly={endedUnsaved}
          placeholder="Excerpt — a sentence or two shown in listings"
          aria-label="Excerpt"
          className="mt-2 w-full resize-none border-none bg-transparent text-base text-gray-500 outline-none [field-sizing:content]"
        />
        <div className="my-4 border-t border-gray-100" />
        <MarkdownContentEditor
          value={body}
          onChange={onBody}
          upload={upload}
          canUpload={options?.can_upload !== false}
          imageButton
          onError={onImageError}
          readOnly={endedUnsaved}
          toolbarTarget={toolbarEl}
          toolbarClassName="px-3 pb-2"
          buttonClassName="rounded p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          surfaceClassName=""
        />
      </main>

      {drawer && keyRef.current && (
        <PostDrawer
          tab={drawer}
          onTab={setDrawer}
          onClose={() => setDrawer(null)}
          editKey={keyRef.current}
          details={details}
          onDetails={onDetails}
          options={options}
          published={doc?.status === "published"}
          readOnly={endedUnsaved}
          onTrash={() => void moveToTrash()}
        />
      )}
    </div>
  );
}

function SaveIndicator({ state, error }: { state: SaveState; error: string }) {
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "unsaved") return <span>Unsaved changes</span>;
  if (state === "conflict") return <span className="text-amber-700">Needs your choice — not saved yet</span>;
  if (state === "error") return <span className="text-red-600">{error || "Couldn't save"}</span>;
  return (
    <span className="flex items-center gap-1 text-emerald-700">
      <Check className="h-3 w-3" /> Saved to CMS
    </span>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white p-6 text-center text-sm text-gray-500">
      <div className="max-w-md">{children}</div>
    </div>
  );
}
