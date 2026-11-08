import { NextRequest, NextResponse } from "next/server";
import { previewVersion, resolvePreviewLink } from "@/lib/preview-link";
import { escapeHtml } from "@/lib/utils";

type Ctx = { params: Promise<{ token: string }> };

// Hand-expanded copy of the .prose-preview rules in src/app/globals.css —
// this response is a standalone HTML document (so status can be a real
// 404/410, which a Next.js *page* can't return), so it can't rely on the
// app's compiled Tailwind bundle.
const PROSE_CSS = `
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; color: #111827; background: #fff; }
  .preview-banner { background: #fef3c7; color: #92400e; padding: 0.75rem 1.5rem; font-size: 0.875rem; border-bottom: 1px solid #fde68a; }
  main { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
  .prose-preview { max-width: none; }
  .prose-preview h1 { font-size: 1.875rem; font-weight: 700; margin: 1.5rem 0 1rem; }
  .prose-preview h2 { font-size: 1.5rem; font-weight: 700; margin: 1.25rem 0 0.75rem; }
  .prose-preview h3 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
  .prose-preview p { margin-bottom: 1rem; line-height: 1.625; }
  .prose-preview ul { list-style-type: disc; list-style-position: inside; margin-bottom: 1rem; }
  .prose-preview ol { list-style-type: decimal; list-style-position: inside; margin-bottom: 1rem; }
  .prose-preview a { color: #2563eb; text-decoration: underline; }
  .prose-preview img { max-width: 100%; height: auto; border-radius: 0.5rem; margin: 1rem 0; }
  .prose-preview blockquote { border-left: 4px solid #d1d5db; padding-left: 1rem; font-style: italic; color: #4b5563; margin: 1rem 0; }
  .prose-preview code { background: #f3f4f6; border-radius: 0.25rem; padding: 0.125rem 0.25rem; font-family: monospace; font-size: 0.875rem; }
  .prose-preview pre { background: #f3f4f6; border-radius: 0.25rem; padding: 1rem; overflow-x: auto; margin: 1rem 0; }
  .prose-preview strong { font-weight: 700; }
  .prose-preview em { font-style: italic; }
  .preview-live { float: right; font-weight: 600; }
  .preview-live::before { content: ""; display: inline-block; width: 0.5rem; height: 0.5rem; margin-right: 0.375rem; border-radius: 9999px; background: #16a34a; vertical-align: middle; }
  main.preview-updated { animation: preview-flash 1.2s ease-out; }
  @keyframes preview-flash { from { background: #ecfdf5; } to { background: transparent; } }
`;

// Live reload: the page polls ./version (a few bytes, no content) and, when the
// post has changed, re-fetches this same URL and swaps only <main> — so an
// author editing the draft from their editor, the CMS, or an LLM over MCP sees
// the change land within a couple of seconds without losing their scroll
// position. Polling rather than a push channel keeps this a plain stateless GET
// that works behind any proxy. It deliberately keeps polling while
// document.hidden: an embedded preview pane (e.g. the Claude desktop app's
// browser panel) can report hidden while on screen, and a preview that
// silently stops updating is the one failure this page exists to prevent.
const LIVE_RELOAD_SCRIPT = `
(function () {
  var version = document.body.getAttribute("data-version");
  var versionUrl = location.pathname.replace(/[/]$/, "") + "/version";
  var busy = false;
  async function check() {
    if (busy) return;
    busy = true;
    try {
      var res = await fetch(versionUrl, { cache: "no-store" });
      if (!res.ok) return;
      var next = String((await res.json()).version);
      if (next === version) return;
      var page = await fetch(location.href, { cache: "no-store" });
      if (!page.ok) return;
      var doc = new DOMParser().parseFromString(await page.text(), "text/html");
      var fresh = doc.querySelector("main");
      var current = document.querySelector("main");
      if (!fresh || !current) return;
      fresh.classList.add("preview-updated");
      current.replaceWith(fresh);
      document.title = doc.title;
      version = doc.body.getAttribute("data-version");
    } catch (e) {
      /* offline or server restarting — try again on the next tick */
    } finally {
      busy = false;
    }
  }
  setInterval(check, 2000);
  document.addEventListener("visibilitychange", check);
})();
`;

function htmlPage(title: string, body: string, version?: string): string {
  const bodyOpen = version === undefined ? "<body>" : `<body data-version="${escapeHtml(version)}">`;
  const script = version === undefined ? "" : `<script>${LIVE_RELOAD_SCRIPT}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><style>${PROSE_CSS}</style></head>${bodyOpen}${body}${script}</body></html>`;
}

function messagePage(title: string, message: string): string {
  return htmlPage(
    title,
    `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`
  );
}

function htmlResponse(html: string, status: number): NextResponse {
  return new NextResponse(html, {
    status,
    // no-store: the live-reload script re-fetches this URL to pick up edits.
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const result = await resolvePreviewLink(token);

  if (result.status === 410) {
    return htmlResponse(
      messagePage("Preview link expired", "Ask the author for a new preview link."),
      410
    );
  }
  if (result.status !== 200) {
    return htmlResponse(
      messagePage("Preview link not found", "This link is invalid or has been revoked."),
      404
    );
  }

  const { post } = result;
  const expiresAt = post.preview_token_expires_at as Date;
  const body = `
    <div class="preview-banner"><span class="preview-live">Live</span>Draft preview — not published. Updates automatically as the post is edited. Link expires ${escapeHtml(
      expiresAt.toUTCString()
    )}.</div>
    <main class="prose-preview">
      <h1>${escapeHtml(post.title)}</h1>
      ${post.content_html ?? ""}
    </main>
  `;
  return htmlResponse(htmlPage(post.title, body, previewVersion(post)), 200);
}
