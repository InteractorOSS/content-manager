import sanitizeHtml from "sanitize-html";

// Server-side text extraction for style samples ("provide a link" flow).

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|\[::1\]|\[fc|\[fd|\[fe80)/i;

export async function extractFromUrl(
  url: string
): Promise<{ title: string | null; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!/^https?:$/.test(parsed.protocol) || PRIVATE_HOST.test(parsed.hostname)) {
    throw new Error("Only public http(s) URLs are allowed");
  }

  const res = await fetch(parsed.toString(), {
    headers: { "User-Agent": "InteractorCMS-StyleSampler/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

  const html = await res.text();
  const titleMatch =
    html.match(/<title[^>]*>([^<]+)<\/title>/i) ??
    html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

  // Prefer the article/main body when present; fall back to <body>.
  const scoped =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ??
    html;

  const text = htmlToText(scoped);
  if (text.length < 200) {
    throw new Error(
      "Could not extract meaningful text from that page (is it JS-rendered?)"
    );
  }

  return {
    title: titleMatch?.[1]?.trim() ?? null,
    text: text.slice(0, 60_000),
  };
}

export function htmlToText(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    exclusiveFilter: () => false,
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "nav", "footer"],
  });
  return cleaned.replace(/&[a-z#0-9]+;/gi, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
