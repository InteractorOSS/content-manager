import sanitizeHtml from "sanitize-html";

// Post content is stored as HTML and rendered with dangerouslySetInnerHTML
// here and server-side on the public website, so it must be sanitized at
// write time. The policy keeps everything the post editor produces (rich
// text, images, column-layout divs with inline styles, YouTube embeds) and
// strips script/object/embed/form tags, on* handlers, and javascript: URLs.
const POLICY: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "h1",
    "h2",
    "figure",
    "figcaption",
    "iframe",
    "video",
    "source",
    "span",
  ],
  allowedAttributes: {
    "*": ["class", "style", "id"],
    a: ["href", "target", "rel", "title"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    iframe: ["src", "width", "height", "frameborder", "allowfullscreen", "allow"],
    video: ["src", "controls", "width", "height", "poster"],
    source: ["src", "type"],
  },
  allowedIframeHostnames: [
    "www.youtube.com",
    "www.youtube-nocookie.com",
    "player.vimeo.com",
  ],
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
};

export function sanitizePostContent(html: string): string {
  return sanitizeHtml(html, POLICY);
}
