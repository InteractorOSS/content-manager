// Copyright (c) 2026 Interactor, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Single source of truth for the CMS's documented API surface (G#22).
 *
 * `GET /api/public/openapi.json` (src/app/api/public/openapi.json/route.ts) generates an
 * OpenAPI 3.1 document from `ENDPOINTS` below at request time, and
 * `spec.test.ts` walks every `src/app/api/**\/route.ts` file on disk and fails
 * CI the moment this list and the routes disagree in either direction. No
 * endpoint fact should be typed twice anywhere else — extend this file, not a
 * second description of the same route.
 *
 * To document a new endpoint: add one `DocEndpoint` below (or add its path
 * prefix to `UNDOCUMENTED` with a reason if it's deliberately internal). The
 * drift test will refuse to pass until one or the other happens.
 */

import { z } from "zod";
import { contentTypeSchema } from "@/lib/content-types";
import { siteSlugSchema } from "@/lib/sites";
import { FAQ_CATEGORIES, FAQ_AUDIENCES, FAQ_STATUSES } from "@/lib/faq";

export type DocAuth = "public" | "pat-or-session" | "session-only";

export interface DocParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  example?: unknown;
}

/** A JSON Schema (draft 2020-12) fragment — hand-written, or produced by `z.toJSONSchema()`. */
export type DocSchema = Record<string, unknown>;

export interface DocResponse {
  status: number;
  description: string;
  schema?: DocSchema;
  example?: unknown;
}

export interface DocExample {
  title: string;
  /** The exact curl command that was actually executed against a local instance. */
  curl: string;
  response: {
    status: number;
    /** The real, observed response body — omitted only for a binary/non-JSON body. */
    body?: unknown;
    note?: string;
  };
}

export interface DocEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  routeFile: string;
  group: string;
  summary: string;
  description?: string;
  auth: DocAuth;
  permission?: string;
  queryParams?: DocParam[];
  pathParams?: DocParam[];
  body?: DocSchema;
  /** Request body media type, e.g. "multipart/form-data" for a file upload. Defaults to "application/json". */
  bodyContentType?: string;
  responses: DocResponse[];
  examples: DocExample[];
}

// ─── Shared field schemas, derived from the zod schemas that already govern them ──

/** `Post.type` / `ContentType.slug` — see src/lib/content-types.ts. */
const TYPE_SCHEMA = z.toJSONSchema(contentTypeSchema);
/** `Post.platforms[]` entries / `Site.slug` — see src/lib/sites.ts. */
const SITE_SLUG_SCHEMA = z.toJSONSchema(siteSlugSchema);

// ─── Shared response shapes ────────────────────────────────────────────────

const RESPONSE_401: DocResponse = {
  status: 401,
  description: "No session cookie and no recognized `Authorization: Bearer cms_pat_...` header.",
  example: { error: "Unauthorized" },
};

const RESPONSE_404: DocResponse = {
  status: 404,
  description: "No resource with that id/slug in this organization.",
  example: { error: "Not found" },
};

const RESPONSE_CONTENT_HASH_CONFLICT: DocResponse = {
  status: 409,
  description:
    "Optimistic-concurrency conflict: `expected_content_hash` (or an `If-Match` header) was sent and no longer matches — someone else wrote this post since the caller loaded it.",
  example: {
    error: "This post was edited since you loaded it — re-fetch, re-apply your change, and retry",
    current_hash: "a1b2c3...",
    updated_at: "2026-09-12T22:26:22.147Z",
    last_editor: { id: "cmtyxp8h50002yof6qpeapon9", name: "API Docs Admin" },
  },
};

function siteScopeResponse(action: "read" | "change" | "target"): DocResponse {
  return {
    status: 403,
    description: `The caller's token is site-scoped (see \`token.site_scopes\` on \`GET /api/me\`) and this post falls outside it for a "${action}" request. Never a 404 — the post is not a secret from the token's organization.`,
    schema: {
      type: "object",
      properties: {
        error: { type: "string" },
        token_site_scopes: { type: "array", items: { type: "string" } },
        post_sites: { type: "array", items: { type: "string" } },
      },
      required: ["error", "token_site_scopes", "post_sites"],
    },
  };
}

// ─── Public read (no auth) ─────────────────────────────────────────────────

const PUBLIC_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/public/posts",
    routeFile: "src/app/api/public/posts/route.ts",
    group: "Public read",
    summary: "List published posts",
    description:
      "Every published, non-future-dated post across the organization, newest first. This is what the website's blog index calls. " +
      "The response is an explicit allowlist of public-safe fields, not the raw row: `seo_title`, `canonical_url`, `og_image`(_alt), " +
      "`noindex`, `content_updated_at`, `answer_summary` and `redirect_to` are new (G#31); the last three are omitted entirely, " +
      "never sent as `null`, when unset. `author` is an entity (`{name, slug, job_title, bio, avatar_url, same_as}`) rather than " +
      "just the `author_name` string — `null` until the credited person has set a public author_slug. Pass `?platform=<site slug>` " +
      "to also get a resolved `seo` block (G#33) — `{title, description, canonical, robots, og, twitter, json_ld}` — computed once " +
      "for this site rather than left for each consumer to build; every field is per-site (canonical URL, publisher identity, " +
      "sameAs) so it is only sent when the platform names a registered Site. `json_ld` is an array of independent nodes (each " +
      "carries its own `@context`): BlogPosting (Person author when the post has a byline, Organization publisher from the " +
      "site/org), a two-level BreadcrumbList (site, post — no guessed category rung), and an FAQPage node only when the body " +
      "has a visible FAQ section.",
    auth: "public",
    queryParams: [
      { name: "type", type: "string", description: "Filter to one content type (e.g. `blog`)." },
      { name: "category_id", type: "string", description: "Filter to one category id." },
      {
        name: "platform",
        type: "string",
        description:
          "Filter to posts targeting this site slug (`Post.platforms`). Omit to get every published post regardless of distribution target.",
        example: "product-manager",
      },
      {
        name: "author_slug",
        type: "string",
        description:
          "Filter to posts by one author's public `author_slug` (see `author.slug` in the response). An unrecognized slug returns an empty page, not an error — same contract as every other filter here.",
      },
      { name: "page", type: "integer", description: "1-indexed page number. Default 1." },
      { name: "per_page", type: "integer", description: "Page size, capped at 100. Default 50." },
    ],
    responses: [
      {
        status: 200,
        description: "A page of published posts, each including its category.",
      },
    ],
    examples: [
      {
        title: "List posts targeting product-manager",
        curl: "curl \"https://cms.interactor.com/api/public/posts?platform=product-manager\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyxp8kn0009yof6u7xh6cpi",
                title: "Announcing the API Docs Foundation",
                slug: "announcing-the-api-docs-foundation",
                content: "# Hello\n\nThis is a **published** post used to generate real API examples.",
                content_html:
                  "<h1>Hello</h1>\n<p>This is a <strong>published</strong> post used to generate real API examples.</p>",
                excerpt: "A short excerpt for the fixture post.",
                status: "published",
                type: "blog",
                author_name: "API Docs Admin",
                published_at: "2026-09-12T22:05:52.672Z",
                reading_time: 1,
                tags: ["announcement", "docs"],
                platforms: ["website", "product-manager"],
                category: { id: "cmtyxp8il0006yof66fgkf2b5", name: "Product Updates", slug: "product-updates" },
              },
            ],
            meta: { total: 1, page: 1, per_page: 50 },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/posts/slug/{slug}",
    routeFile: "src/app/api/public/posts/slug/[slug]/route.ts",
    group: "Public read",
    summary: "Get one published post by slug",
    description:
      "A slug that matches no live post but WAS a post's slug before it was renamed (G#31) answers " +
      "`{data: {redirect_slug}}` instead of 404 — look up `PostSlugHistory` says this content moved, not that it's gone. " +
      "`redirect_slug` is the new current slug on this same site; only names a redirect target when the successor post " +
      "is still published and (if `?platform=` was passed) still targets that site. Distinct from a post's own free-text " +
      "`redirect_to` field, which is an author's manual override, not a derived rename record. " +
      "A `.md` suffix on the slug (G#34) — e.g. `.../slug/my-post.md` — returns clean Markdown + YAML frontmatter " +
      "(`text/markdown`) built from this SAME public allowlist instead of JSON; an HTML-format post's body is converted " +
      "from its sanitized render, not served as raw pasted HTML.",
    auth: "public",
    pathParams: [{ name: "slug", type: "string", required: true, description: "The post's slug, or a slug it used to have." }],
    queryParams: [
      {
        name: "platform",
        type: "string",
        description: "404 the post if it does not target this site slug.",
      },
    ],
    responses: [
      { status: 200, description: "The post, including its category and author; or `{redirect_slug}` for a retired slug." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Fetch a post by slug",
        curl: "curl \"https://cms.interactor.com/api/public/posts/slug/announcing-the-api-docs-foundation\"",
        response: {
          status: 200,
          body: {
            data: {
              id: "cmtyxp8kn0009yof6u7xh6cpi",
              title: "Announcing the API Docs Foundation",
              slug: "announcing-the-api-docs-foundation",
              status: "published",
              category: { id: "cmtyxp8il0006yof66fgkf2b5", name: "Product Updates", slug: "product-updates" },
            },
          },
        },
      },
      {
        title: "A retired slug redirects to its successor",
        curl: "curl \"https://cms.interactor.com/api/public/posts/slug/announcing-the-old-name\"",
        response: {
          status: 200,
          body: { data: { redirect_slug: "announcing-the-api-docs-foundation" } },
        },
      },
      {
        title: "Fetch a post as clean Markdown + frontmatter",
        curl: "curl \"https://cms.interactor.com/api/public/posts/slug/announcing-the-api-docs-foundation.md\"",
        response: { status: 200, note: "A text/markdown document (YAML frontmatter + body), not JSON." },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/posts/{slug}/comments",
    routeFile: "src/app/api/public/posts/[slug]/comments/route.ts",
    group: "Public read",
    summary: "List a post's published comments",
    description: "Published comments only, oldest first — pending/spam/rejected comments never appear here.",
    auth: "public",
    pathParams: [{ name: "slug", type: "string", required: true, description: "The post's slug." }],
    responses: [{ status: 200, description: "The post's published comments." }, RESPONSE_404],
    examples: [
      {
        title: "List comments on a post with none yet",
        curl: "curl \"https://cms.interactor.com/api/public/posts/announcing-the-api-docs-foundation/comments\"",
        response: { status: 200, body: { data: [] } },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/public/posts/{slug}/comments",
    routeFile: "src/app/api/public/posts/[slug]/comments/route.ts",
    group: "Public read",
    summary: "Submit a comment on a post",
    description:
      "Every new comment lands as `pending` — nothing is auto-published. The consuming website's own spam guard runs before this is ever called; this endpoint only does basic field validation.",
    auth: "public",
    pathParams: [{ name: "slug", type: "string", required: true, description: "Must be a published post's slug." }],
    body: {
      type: "object",
      properties: {
        author_name: { type: "string" },
        author_email: { type: "string", format: "email" },
        content: { type: "string", maxLength: 2000 },
      },
      required: ["author_name", "author_email", "content"],
    },
    responses: [
      { status: 201, description: "Comment accepted, pending moderation." },
      { status: 400, description: "Missing field, invalid email, or content over 2000 characters." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Submit a comment",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/public/posts/announcing-the-api-docs-foundation/comments\" \\\n" +
          "  -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"author_name\":\"A Reader\",\"author_email\":\"reader2@example.com\",\"content\":\"Nice writeup!\"}'",
        response: { status: 201, body: { data: { id: "cmtyyfbo10000trf60uk1iiy4", status: "pending" } } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/faq",
    routeFile: "src/app/api/public/faq/route.ts",
    group: "Public read",
    summary: "List published, public FAQ entries",
    description:
      "Filters through `PUBLIC_FAQ_WHERE` (src/lib/faq.ts) — the one place that defines \"public\" for this API. A `sales-only` or unpublished entry never appears here. `{{facts.<key>}}` tokens in `answer` are substituted at read time.",
    auth: "public",
    queryParams: [
      {
        name: "category",
        type: "string",
        description: `One of: ${FAQ_CATEGORIES.join(", ")}.`,
      },
    ],
    responses: [
      { status: 200, description: "Matching FAQ entries." },
      { status: 400, description: "Unknown `category` value." },
    ],
    examples: [
      {
        title: "List public FAQs in a category",
        curl: "curl \"https://cms.interactor.com/api/public/faq?category=self-hosting\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "what-is-the-api-docs-foundation",
                question: "What is the API docs foundation?",
                answer: "It is the typed spec + OpenAPI document + drift test described in CLAUDE.md.",
                answer_error: null,
                category: "self-hosting",
                last_verified: null,
                verify_every_days: 365,
                sources: [],
                related: [],
                asked_count: 0,
              },
            ],
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/faq/{id}",
    routeFile: "src/app/api/public/faq/[id]/route.ts",
    group: "Public read",
    summary: "Get one FAQ entry by slug",
    description:
      "`{id}` is the FAQ's human-readable `slug` (e.g. `self-hosting-cloud-cost`), not its database id. A sales-only or unpublished entry 404s here exactly as if it didn't exist — there is no authenticated path through this route that would leak it.",
    auth: "public",
    pathParams: [{ name: "id", type: "string", required: true, description: "The FAQ's slug." }],
    responses: [{ status: 200, description: "The FAQ entry." }, RESPONSE_404],
    examples: [
      {
        title: "Fetch a public FAQ by slug",
        curl: "curl \"https://cms.interactor.com/api/public/faq/what-is-the-api-docs-foundation\"",
        response: {
          status: 200,
          body: {
            data: {
              id: "what-is-the-api-docs-foundation",
              question: "What is the API docs foundation?",
              answer: "It is the typed spec + OpenAPI document + drift test described in CLAUDE.md.",
              category: "self-hosting",
            },
          },
        },
      },
      {
        title: "Unknown slug",
        curl: "curl \"https://cms.interactor.com/api/public/faq/does-not-exist\"",
        response: { status: 404, body: { error: "Not found" } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/rss.xml",
    routeFile: "src/app/api/public/rss.xml/route.ts",
    group: "Public read",
    summary: "RSS feed of a site's published posts",
    description:
      "Unlike `/api/public/posts`, `platform` is required here — a feed needs exactly one site's `url` (registered from Settings → Sites) to build each `<link>` from, and there is no \"all sites\" feed to fall back to. 404s if no `Site` row is registered for that slug.",
    auth: "public",
    queryParams: [
      {
        name: "platform",
        type: "string",
        required: true,
        description: "The registered site slug to build the feed for.",
        example: "product-manager",
      },
    ],
    responses: [
      { status: 200, description: "`application/rss+xml` body." },
      { status: 400, description: "`?platform=` was omitted." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Fetch a site's RSS feed",
        curl: "curl \"https://cms.interactor.com/api/public/rss.xml?platform=product-manager\"",
        response: { status: 200, note: "An application/rss+xml document, not JSON." },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/sitemap.xml",
    routeFile: "src/app/api/public/sitemap.xml/route.ts",
    group: "Public read",
    summary: "Sitemap of a site's published posts",
    description:
      "Same `?platform=` contract as `/api/public/rss.xml` (required, 404s for an unregistered slug) — a plain XML sitemap of the site's published post URLs. No item cap (G#34): every published post is included. `<lastmod>` is `content_updated_at` (falling back to `updated_at`), never `published_at` — a pure tag/status edit does not bump it. Excludes `noindex` posts and posts whose `canonical_url` points at a different site (a syndicated copy, not this site's canonical source).",
    auth: "public",
    queryParams: [
      {
        name: "platform",
        type: "string",
        required: true,
        description: "The registered site slug to build the sitemap for.",
        example: "product-manager",
      },
    ],
    responses: [
      { status: 200, description: "`application/xml` body." },
      { status: 400, description: "`?platform=` was omitted." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Fetch a site's sitemap",
        curl: "curl \"https://cms.interactor.com/api/public/sitemap.xml?platform=product-manager\"",
        response: { status: 200, note: "An application/xml document, not JSON." },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/llms.txt",
    routeFile: "src/app/api/public/llms.txt/route.ts",
    group: "Public read",
    summary: "llms.txt index of a site's published posts",
    description:
      "Same `?platform=` contract as `/api/public/rss.xml` (required, 404s for an unregistered slug) — a plain-text `llms.txt` (llmstxt.org convention) listing every published post as a Markdown link with a one-line description. A by-product, per SEO-AEO-GEO-PLAN.md's own framing: near-zero cost, no claim that any crawler treats it specially.",
    auth: "public",
    queryParams: [
      {
        name: "platform",
        type: "string",
        required: true,
        description: "The registered site slug to build the index for.",
        example: "product-manager",
      },
    ],
    responses: [
      { status: 200, description: "`text/plain` body." },
      { status: 400, description: "`?platform=` was omitted." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Fetch a site's llms.txt",
        curl: "curl \"https://cms.interactor.com/api/public/llms.txt?platform=product-manager\"",
        response: { status: 200, note: "A text/plain document, not JSON." },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/indexnow-key",
    routeFile: "src/app/api/public/indexnow-key/route.ts",
    group: "Public read",
    summary: "A site's IndexNow verification key",
    description:
      "IndexNow (bing.com/indexnow) requires the CONSUMING site to host this exact string at `${site.url}/<key>.txt` before a ping naming that key is trusted — the CMS cannot host that file itself (it lives on the site's own domain), so this is the one door the key comes out of. Generates and persists a key on first read for a site that has never had one (a self-hosted deployment upgrading onto this column needs no manual step).",
    auth: "public",
    queryParams: [
      {
        name: "platform",
        type: "string",
        required: true,
        description: "The registered site slug to fetch the key for.",
        example: "product-manager",
      },
    ],
    responses: [
      { status: 200, description: "`{data: {key}}`." },
      { status: 400, description: "`?platform=` was omitted." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Fetch a site's IndexNow key",
        curl: "curl \"https://cms.interactor.com/api/public/indexnow-key?platform=product-manager\"",
        response: { status: 200, body: { data: { key: "3a1f9c2b8e4d4a5f9b1c7e2d6a0f8b3c" } } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/categories",
    routeFile: "src/app/api/public/categories/route.ts",
    group: "Public read",
    summary: "List categories with published-post counts",
    auth: "public",
    responses: [{ status: 200, description: "Every category in the organization, with `post_count`." }],
    examples: [
      {
        title: "List categories",
        curl: "curl \"https://cms.interactor.com/api/public/categories\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyxp8il0006yof66fgkf2b5",
                name: "Product Updates",
                slug: "product-updates",
                description: "Release notes and product news",
                color: null,
                sort_order: 0,
                post_count: 1,
              },
            ],
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/health",
    routeFile: "src/app/api/public/health/route.ts",
    group: "Public read",
    summary: "Health check",
    description: "Pings the database. Used by Caddy's active upstream monitoring.",
    auth: "public",
    responses: [
      { status: 200, description: "Database reachable." },
      { status: 503, description: "Database unreachable." },
    ],
    examples: [
      {
        title: "Health check",
        curl: "curl \"https://cms.interactor.com/api/public/health\"",
        response: { status: 200, body: { status: "ok" } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/public/openapi.json",
    routeFile: "src/app/api/public/openapi.json/route.ts",
    group: "Public read",
    summary: "This OpenAPI 3.1 document",
    description: "Generated from this spec file at request time. Unauthenticated, CORS-enabled.",
    auth: "public",
    responses: [{ status: 200, description: "The OpenAPI 3.1 document." }],
    examples: [
      {
        title: "Fetch the OpenAPI document",
        curl: "curl \"https://cms.interactor.com/api/public/openapi.json\"",
        response: { status: 200, note: "The full generated OpenAPI 3.1 document (this document itself)." },
      },
    ],
  },
];

// ─── Forms (public POST carve-out of an otherwise-internal surface) ────────

const FORM_ENDPOINTS: DocEndpoint[] = [
  {
    method: "POST",
    path: "/api/contacts",
    routeFile: "src/app/api/contacts/route.ts",
    group: "Forms",
    summary: "Submit the contact form",
    description:
      "Public for POST only (`PUBLIC_FORM_POSTS` in src/proxy.ts) — GET on this same path lists submissions and requires `admin:access` via a browser session, and is not part of this documented API. Every submission is pinned to the Interactor organization regardless of which site it came from.",
    auth: "public",
    body: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string", format: "email" },
        company: { type: "string" },
        jobTitle: { type: "string" },
        phone: { type: "string" },
        productInterest: { type: "string" },
        country: { type: "string" },
        subject: { type: "string" },
        message: { type: "string" },
        type: { type: "string", enum: ["contact", "demo", "support", "ai_assessment", "question"], default: "contact" },
        source: { type: "string" },
      },
      required: ["firstName", "lastName", "email", "message"],
      description: "`type: \"demo\"` or `\"ai_assessment\"` additionally require company, productInterest, and country.",
    },
    responses: [
      { status: 201, description: "Submission stored." },
      { status: 400, description: "Missing required field(s) or an invalid email." },
      { status: 500, description: "Internal error." },
    ],
    examples: [
      {
        title: "Submit a contact request",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/contacts\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"firstName\":\"Jane\",\"lastName\":\"Doe\",\"email\":\"jane.doe@example.com\",\"message\":\"Interested in a demo\"}'",
        response: { status: 201, body: { success: true, id: "cmtyyfgeq0001trf6mvcbqkm8" } },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/newsletter",
    routeFile: "src/app/api/newsletter/route.ts",
    group: "Forms",
    summary: "Subscribe to the newsletter",
    description:
      "Public for POST only. Re-activates a lapsed subscription; an already-active email still returns 200 with `alreadySubscribed: true` (non-2xx would make callers treat it as an outage and fall back to a local insert).",
    auth: "public",
    body: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        company: { type: "string" },
        source: { type: "string" },
      },
      required: ["email"],
    },
    responses: [
      { status: 201, description: "Subscribed." },
      { status: 200, description: "Already subscribed, or re-subscribed." },
      { status: 400, description: "Missing or invalid email." },
    ],
    examples: [
      {
        title: "Subscribe",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/newsletter\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"email\":\"subscriber@example.com\"}'",
        response: { status: 201, body: { success: true } },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/waitlist",
    routeFile: "src/app/api/waitlist/route.ts",
    group: "Forms",
    summary: "Join the waitlist",
    description: "Public for POST only. An already-present email returns 200 with `alreadySubscribed: true`.",
    auth: "public",
    body: {
      type: "object",
      properties: { email: { type: "string", format: "email" }, source: { type: "string" } },
      required: ["email"],
    },
    responses: [
      { status: 201, description: "Added to the waitlist." },
      { status: 200, description: "Already on the waitlist." },
      { status: 400, description: "Missing or invalid email." },
    ],
    examples: [
      {
        title: "Join the waitlist",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/waitlist\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"email\":\"waitlisted@example.com\"}'",
        response: { status: 201, body: { success: true } },
      },
    ],
  },
];

// ─── Posts ──────────────────────────────────────────────────────────────────

const POST_BODY_SCHEMA: DocSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    slug: { type: "string", description: "Defaults to a slugified title." },
    content: { type: "string" },
    content_format: { type: "string", enum: ["markdown", "html"], default: "markdown" },
    excerpt: { type: "string" },
    status: { type: "string", enum: ["draft", "published"], description: "Publishing requires `content:publish`; otherwise the post is saved as a draft even if `published` is requested." },
    type: TYPE_SCHEMA,
    featured_image: { type: "string" },
    featured_image_alt: { type: "string" },
    meta_description: { type: "string" },
    meta_keywords: { type: "string" },
    seo_title: { type: "string", description: "Overrides `title` in <title>/og:title/twitter:title. Blank clears it." },
    canonical_url: { type: "string", description: "Set only for a syndicated copy of a post published elsewhere first." },
    og_image: { type: "string", description: "Overrides `featured_image` for Open Graph/Twitter cards." },
    og_image_alt: { type: "string" },
    noindex: { type: "boolean", default: false },
    answer_summary: { type: "string", description: "A 40-60 word self-contained answer to the post's question — the TL;DR/AI-answer-engine source." },
    redirect_to: { type: "string", description: "This slug has been superseded: a path or absolute URL a consuming site should permanently redirect readers to." },
    mark_updated: { type: "boolean", description: "Force `content_updated_at` to now even though title/content/content_format/excerpt didn't change." },
    category_id: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    platforms: {
      type: "array",
      items: SITE_SLUG_SCHEMA,
      description: "Distribution targets. Defaults to `[\"website\"]` when omitted; an empty/all-invalid list is rejected rather than creating an undistributed post.",
    },
    author_id: { type: "string", description: "Reassigning authorship away from the caller requires `content:edit_any`." },
  },
};

const POSTS_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/posts",
    routeFile: "src/app/api/cms/posts/route.ts",
    group: "Posts",
    summary: "List posts",
    description:
      "`?status=published` is readable by any signed-in caller; any other filter (or no filter) requires `content:view`. A site-scoped token's results are additionally filtered to posts targeting its sites.",
    auth: "pat-or-session",
    permission: "content:view (unless ?status=published)",
    queryParams: [
      { name: "status", type: "string", description: "e.g. `draft`, `published`." },
      { name: "type", type: "string", description: "Filter by content type." },
      { name: "category_id", type: "string", description: "Filter by category." },
      { name: "site", type: "string", description: "A site slug: only posts targeting that site (`Post.platforms` contains it)." },
      { name: "search", type: "string", description: "Case-insensitive text matched against title, slug, excerpt and body (first 200 characters used)." },
      { name: "workflow_status", type: "string", description: "`draft` | `pending_review` | `approved` | `rejected`." },
      { name: "published", type: "string", description: "`true` is shorthand for `status=published`." },
      { name: "page", type: "integer", description: "Default 1." },
      { name: "per_page", type: "integer", description: "Default 50, capped at 100." },
    ],
    responses: [{ status: 200, description: "A page of posts." }, RESPONSE_401],
    examples: [
      {
        title: "List draft posts",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts?status=draft\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyxp8le000ayof6g5jnv6l4",
                title: "Draft: Upcoming Feature",
                slug: "draft-upcoming-feature",
                status: "draft",
                workflow_status: "draft",
                platforms: ["website"],
              },
            ],
            meta: { total: 1, page: 1, per_page: 50 },
          },
        },
      },
      {
        title: "No credential",
        curl: "curl \"https://cms.interactor.com/api/cms/posts\"",
        response: { status: 401, body: { error: "Unauthorized" } },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts",
    routeFile: "src/app/api/cms/posts/route.ts",
    group: "Posts",
    summary: "Create a post",
    auth: "pat-or-session",
    permission: "content:create",
    body: POST_BODY_SCHEMA,
    responses: [
      { status: 201, description: "Post created. Carries a `warning` field instead of erroring if `status: \"published\"` was requested without `content:publish` — the post is saved as a draft." },
      { status: 400, description: "`platforms` resolved to no valid site." },
      { status: 403, description: "Site-scope refusal (create must target only in-scope sites), or `content:edit_any` needed to set `author_id`." },
      { status: 409, description: "A post with this slug already exists." },
    ],
    examples: [
      {
        title: "Create a draft post",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/posts\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"title\":\"A Throwaway Post For Docs\",\"content\":\"Body text.\",\"status\":\"draft\",\"tags\":[\"temp-doc-tag\"]}'",
        response: {
          status: 201,
          body: {
            data: {
              id: "cmtyyfho30004trf6hbnax6dy",
              title: "A Throwaway Post For Docs",
              slug: "a-throwaway-post-for-docs",
              content: "Body text.",
              status: "draft",
              tags: ["temp-doc-tag"],
              platforms: ["website"],
            },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}",
    routeFile: "src/app/api/cms/posts/[id]/route.ts",
    group: "Posts",
    summary: "Get one post",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 200, description: "The post." }, RESPONSE_404, siteScopeResponse("read")],
    examples: [
      {
        title: "Fetch a post",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi\"",
        response: {
          status: 200,
          body: {
            data: {
              id: "cmtyxp8kn0009yof6u7xh6cpi",
              title: "Announcing the API Docs Foundation",
              slug: "announcing-the-api-docs-foundation",
              status: "published",
              category: { id: "cmtyxp8il0006yof66fgkf2b5", name: "Product Updates", slug: "product-updates" },
              preview_url: null,
            },
          },
        },
      },
      {
        title: "Unknown id",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/does-not-exist\"",
        response: { status: 404, body: { error: "Not found" } },
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/cms/posts/{id}",
    routeFile: "src/app/api/cms/posts/[id]/route.ts",
    group: "Posts",
    summary: "Replace a post's editable fields",
    description:
      "Every field is optional — omitted fields are left unchanged. Pass `expected_content_hash` (or an `If-Match` header carrying the post's `content_hash`) for optimistic-concurrency protection; a stale value 409s instead of silently overwriting a newer edit. A site-scoped token must have both the post's current sites AND any new `platforms` within its scope.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: { ...POST_BODY_SCHEMA, properties: { ...POST_BODY_SCHEMA.properties as object, expected_content_hash: { type: ["string", "null"], description: "Optimistic-concurrency guard; alternative to the `If-Match` header." } } },
    responses: [
      { status: 200, description: "The updated post." },
      RESPONSE_404,
      { status: 403, description: "Not the post's author (needs `content:edit_any`), or a site-scope refusal." },
      RESPONSE_CONTENT_HASH_CONFLICT,
      { status: 409, description: "The new slug collides with another post." },
    ],
    examples: [
      {
        title: "Update a post's excerpt",
        curl:
          "curl -X PUT \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"excerpt\":\"An updated excerpt for the fixture post.\"}'",
        response: {
          status: 200,
          body: {
            data: {
              id: "cmtyxp8kn0009yof6u7xh6cpi",
              excerpt: "An updated excerpt for the fixture post.",
              updated_by_name: "API Docs Admin",
            },
          },
        },
      },
      {
        title: "Site-scoped token editing an out-of-scope post",
        curl:
          "curl -X PUT \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4\" -H \"Authorization: Bearer cms_pat_...(scoped to product-manager)\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"excerpt\":\"Trying to edit a website-only post with a product-manager-scoped token.\"}'",
        response: {
          status: 403,
          body: {
            error:
              "This token is limited to the site product-manager, and this post also targets website, so the token can't change it. Use a token that covers website too, or make the change in the CMS.",
            token_site_scopes: ["product-manager"],
            post_sites: ["website"],
          },
        },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/posts/{id}",
    routeFile: "src/app/api/cms/posts/[id]/route.ts",
    group: "Posts",
    summary: "Delete a post",
    description:
      "Moves the post to the trash: it disappears from every listing and the public API at once and its slug is free again, but `GET /api/cms/posts/trash` lists it and `POST /api/cms/posts/trash/{id}/restore` brings it back (as a draft) for 30 days. Comments and revision history are not kept.",
    auth: "pat-or-session",
    permission: "content:delete",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 204, description: "Moved to the trash." }, RESPONSE_404, siteScopeResponse("change")],
    examples: [
      {
        title: "Delete a post",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/posts/cmtyyfho30004trf6hbnax6dy\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/trash",
    routeFile: "src/app/api/cms/posts/trash/route.ts",
    group: "Posts",
    summary: "List deleted posts (the trash)",
    description:
      "Posts deleted in the last 30 days, newest first. `id` is the trash entry (pass it to restore), `post_id` the deleted post's own id. Entries older than 30 days are removed for good. A site-scoped token sees only entries for its sites.",
    auth: "pat-or-session",
    permission: "content:view",
    queryParams: [{ name: "search", type: "string", description: "Case-insensitive text matched against title and slug." }],
    responses: [{ status: 200, description: "Trash entries and `retention_days`." }, RESPONSE_401],
    examples: [
      {
        title: "Find a deleted post",
        curl: "curl \"https://cms.interactor.com/api/cms/posts/trash?search=trash\" -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmuex7xim00023rf628awptbi",
                post_id: "cmuex7s3j00003rf6b4h8s5zm",
                title: "Trash test",
                slug: "trash-test",
                status: "draft",
                platforms: ["website"],
                deleted_at: "2026-09-24T02:36:44.014Z",
                deleted_by: "dev@example.com",
                expires_at: "2026-10-24T02:36:44.014Z",
              },
            ],
            retention_days: 30,
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/trash/{id}/restore",
    routeFile: "src/app/api/cms/posts/trash/[id]/restore/route.ts",
    group: "Posts",
    summary: "Restore a deleted post",
    description:
      "Recreates the post from the trash, with its old id when that is still free. It always comes back as a DRAFT, so a restore never republishes anything by itself. Its slug gets a `-restored` suffix if another post took it meanwhile, and its social drafts are linked to it again.",
    auth: "pat-or-session",
    permission: "content:create",
    pathParams: [{ name: "id", type: "string", required: true, description: "The trash entry's id (from the trash list), not the post's." }],
    responses: [
      { status: 201, description: "The restored post's id, slug, title and status (`draft`)." },
      { status: 404, description: "Not in the trash: already restored, or removed after 30 days." },
      siteScopeResponse("change"),
    ],
    examples: [
      {
        title: "Restore a post",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/posts/trash/cmuex7xim00023rf628awptbi/restore\" -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 201,
          body: { data: { id: "cmuex7s3j00003rf6b4h8s5zm", slug: "trash-test", title: "Trash test", status: "draft" } },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/social",
    routeFile: "src/app/api/cms/posts/[id]/social/route.ts",
    group: "Posts",
    summary: "A post's social copy",
    description:
      "The current draft per network (`linkedin`, `twitter`, `facebook`, `instagram`, `reddit`, `slack`) written for this post: the newest non-archived social post whose source is the post. Networks with none are left out. `editable` is false once the copy has been published. Backs the `list_social_drafts` MCP tool.",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 200, description: "The drafts." }, RESPONSE_404, siteScopeResponse("read")],
    examples: [
      {
        title: "Read a post's social copy",
        curl: "curl \"https://cms.interactor.com/api/cms/posts/cmuex7s3j00003rf6b4h8s5zm/social\" -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmuex7wy300013rf603nnmlm1",
                network: "linkedin",
                body: "New post: Trash test.",
                parts: [],
                status: "draft",
                scheduled_at: null,
                published_at: null,
                updated_at: "2026-09-24T02:36:43.275Z",
                editable: true,
              },
            ],
          },
        },
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/cms/posts/{id}/social",
    routeFile: "src/app/api/cms/posts/[id]/social/route.ts",
    group: "Posts",
    summary: "Write a post's social copy for one network",
    description:
      "Saves `body` as the network's draft for this post: edits the current draft, or starts one. Copy that has already been published is never rewritten; saving then starts a new draft. An empty body removes an unscheduled draft (`data: null`, `removed: true`). For an X thread, separate tweets with a line containing only `---`: the copy is stored as its first tweet plus thread parts, and each tweet is published as a reply to the one before. On X, LinkedIn and Facebook a `--- first comment` line starts a comment posted under the post once it is live. Reading answers the same text back, with `parts` beside it. Scheduling and publishing stay in the Social queue. Backs the `save_social_draft` MCP tool.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: {
      type: "object",
      required: ["network", "body"],
      properties: {
        network: { type: "string", enum: ["linkedin", "twitter", "facebook", "instagram", "reddit", "slack"] },
        body: { type: "string", maxLength: 10000 },
      },
    },
    responses: [
      { status: 200, description: "The saved draft (or null when removed)." },
      { status: 400, description: "Unknown network, or a body that isn't a string." },
      RESPONSE_404,
      { status: 403, description: "Not the post's own author (needs `content:edit_any`), or a site-scope refusal." },
    ],
    examples: [
      {
        title: "Write the LinkedIn copy",
        curl: "curl -X PUT \"https://cms.interactor.com/api/cms/posts/cmuex7s3j00003rf6b4h8s5zm/social\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{\"network\":\"linkedin\",\"body\":\"New post: Trash test.\"}'",
        response: {
          status: 200,
          body: {
            data: {
              id: "cmuex7wy300013rf603nnmlm1",
              network: "linkedin",
              body: "New post: Trash test.",
              parts: [],
              status: "draft",
              scheduled_at: null,
              published_at: null,
              updated_at: "2026-09-24T02:36:43.275Z",
              editable: true,
            },
            removed: false,
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/social/destinations",
    routeFile: "src/app/api/cms/posts/[id]/social/destinations/route.ts",
    group: "Posts",
    summary: "Where a post's social copy goes",
    description:
      "Every place this post's social copy can be posted to (a Facebook Page, a Slack channel, a subreddit, a manual channel), with `selected` saying whether this post uses it. `state` is `ready`, or `trouble` when the connection needs reconnecting. `overridden` is true when the post made its own choice instead of the channels' defaults. `backlink` is the link each social post carries back to the post, or null when the post has no public address yet.",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 200, description: "The destinations." }, RESPONSE_404, siteScopeResponse("read")],
    examples: [
      {
        title: "Read where a post's social copy goes",
        curl: "curl \"https://cms.interactor.com/api/cms/posts/cmuex7s3j00003rf6b4h8s5zm/social/destinations\" -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 200,
          body: {
            data: {
              destinations: [
                {
                  id: "cmus8x2ab00019b8o4t1m9q0z",
                  network: "facebook",
                  service_name: "Facebook Page",
                  account_name: "Interactor",
                  state: "ready",
                  manual: false,
                  selected: true,
                  is_default: true,
                },
              ],
              overridden: false,
              backlink: "https://example.com/blog/trash-test",
            },
          },
        },
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/cms/posts/{id}/social/destinations",
    routeFile: "src/app/api/cms/posts/[id]/social/destinations/route.ts",
    group: "Posts",
    summary: "Choose where a post's social copy goes",
    description:
      "Stores this post's own choice of destinations and brings its unsent social drafts in line: one target per chosen place of each draft's network. Send `channel_ids: null` to go back to the channels' defaults. Ids that aren't this organization's channels are dropped. Copy that was already submitted, scheduled or published is left as it is.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: {
      type: "object",
      required: ["channel_ids"],
      properties: {
        channel_ids: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "The channel ids this post's copy goes to, or null for the channels' defaults.",
        },
      },
    },
    responses: [
      { status: 200, description: "The destinations after the change." },
      { status: 400, description: "`channel_ids` is neither a list of ids nor null." },
      RESPONSE_404,
      { status: 403, description: "Not the post's own author (needs `content:edit_any`), or a site-scope refusal." },
    ],
    examples: [
      {
        title: "Send this post to one Page only",
        curl: "curl -X PUT \"https://cms.interactor.com/api/cms/posts/cmuex7s3j00003rf6b4h8s5zm/social/destinations\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{\"channel_ids\":[\"cmus8x2ab00019b8o4t1m9q0z\"]}'",
        response: {
          status: 200,
          body: {
            data: {
              destinations: [
                {
                  id: "cmus8x2ab00019b8o4t1m9q0z",
                  network: "facebook",
                  service_name: "Facebook Page",
                  account_name: "Interactor",
                  state: "ready",
                  manual: false,
                  selected: true,
                  is_default: true,
                },
              ],
              overridden: true,
              backlink: "https://example.com/blog/trash-test",
            },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/slug/{slug}",
    routeFile: "src/app/api/cms/posts/slug/[slug]/route.ts",
    group: "Posts",
    summary: "Get one post by slug (authenticated)",
    description: "Like the public slug lookup, but sees drafts too (with `content:view`) and honors an explicit `?status=` filter.",
    auth: "pat-or-session",
    permission: "content:view (unless ?status=published)",
    pathParams: [{ name: "slug", type: "string", required: true, description: "The post's slug." }],
    queryParams: [{ name: "status", type: "string", description: "Restrict the lookup to this status." }],
    responses: [{ status: 200, description: "The post." }, RESPONSE_404, siteScopeResponse("read")],
    examples: [
      {
        title: "Fetch by slug",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/slug/announcing-the-api-docs-foundation\"",
        response: { status: 200, body: { data: { id: "cmtyxp8kn0009yof6u7xh6cpi", slug: "announcing-the-api-docs-foundation" } } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/export",
    routeFile: "src/app/api/cms/posts/export/route.ts",
    group: "Posts",
    summary: "Bulk-export posts as a Markdown vault (.zip)",
    description: "An Obsidian-ready vault folder (`content/posts/<slug>.md` per post, frontmatter + body). A site-scoped token exports only posts targeting its sites.",
    auth: "pat-or-session",
    permission: "content:view",
    queryParams: [{ name: "status", type: "string", description: "Filter by status before exporting." }],
    responses: [{ status: 200, description: "`application/zip` binary body." }],
    examples: [
      {
        title: "Export all posts",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/export\" -o cms-posts-export.zip",
        response: {
          status: 200,
          note: "Binary application/zip body (not shown). Observed headers: Content-Type: application/zip; Content-Disposition: attachment; filename=\"cms-posts-export.zip\".",
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/export",
    routeFile: "src/app/api/cms/posts/[id]/export/route.ts",
    group: "Posts",
    summary: "Export one post as a Markdown file",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 200, description: "`text/markdown` body: frontmatter + content." }, RESPONSE_404, siteScopeResponse("read")],
    examples: [
      {
        title: "Export one post",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi/export\"",
        response: {
          status: 200,
          body:
            "---\nid: cmtyxp8kn0009yof6u7xh6cpi\ncontent_hash: 5a2decc4cac0d84a5faed8c6d1ecfdb0adab802af38761fb0cbcd4948040face\ntitle: Announcing the API Docs Foundation\nslug: announcing-the-api-docs-foundation\nstatus: published\ntype: blog\ncontent_format: markdown\nexcerpt: An updated excerpt for the fixture post.\ncategory: product-updates\ntags:\n  - announcement\n  - docs\nplatforms:\n  - website\n  - product-manager\npublished_at: '2026-09-12T22:05:52.672Z'\n---\n# Hello\n\nThis is a **published** post used to generate real API examples.\n",
        },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/posts/bulk-delete",
    routeFile: "src/app/api/cms/posts/bulk-delete/route.ts",
    group: "Posts",
    summary: "Delete multiple posts at once",
    description:
      "The matched posts go to the trash, like a single delete (restorable for 30 days). A site-scoped token's batch is refused WHOLE if any matched post falls outside its scope — never a silent partial delete.",
    auth: "pat-or-session",
    permission: "content:delete",
    body: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        slugs: { type: "array", items: { type: "string" } },
      },
      description: "Provide `ids` or `slugs` (ids take precedence if both are present).",
    },
    responses: [
      { status: 204, description: "Matched posts deleted (or nothing matched)." },
      { status: 403, description: "Site-scope batch refusal, naming the out-of-scope posts." },
    ],
    examples: [
      {
        title: "Bulk-delete by id",
        curl:
          "curl -X DELETE \"https://cms.interactor.com/api/cms/posts/bulk-delete\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"ids\":[\"cmtyyfho30004trf6hbnax6dy\",\"cmtyyfu2k0006trf6lt81di50\"]}'",
        response: { status: 204 },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/generate-seo",
    routeFile: "src/app/api/cms/posts/generate-seo/route.ts",
    group: "Posts",
    summary: "Heuristically generate SEO fields from a title/content",
    description: "Pure text heuristics (word frequency + truncation) — no AI call. Powers the editor's \"Generate SEO\" button.",
    auth: "pat-or-session",
    permission: "content:create",
    body: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string" } },
      description: "At least one of `title`/`content` is required.",
    },
    responses: [
      { status: 200, description: "Suggested meta_description, meta_keywords, excerpt, featured_image_alt." },
      { status: 400, description: "Both `title` and `content` were empty." },
    ],
    examples: [
      {
        title: "Generate SEO fields",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/posts/generate-seo\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"title\":\"Announcing the API Docs Foundation\",\"content\":\"<p>This is a published post used to generate real API examples for the CMS OpenAPI document.</p>\"}'",
        response: {
          status: 200,
          body: {
            success: true,
            data: {
              meta_description: "This is a published post used to generate real API examples for the CMS OpenAPI document.",
              meta_keywords: "announcing, docs, foundation, published, post, used, generate, real",
              excerpt: "This is a published post used to generate real API examples for the CMS OpenAPI document.",
              featured_image_alt: "Announcing the API Docs Foundation",
            },
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/import",
    routeFile: "src/app/api/cms/posts/import/route.ts",
    group: "Posts",
    summary: "Import a Markdown file (frontmatter + body)",
    description:
      "The write side of the file-based sync feature. Upserts by the frontmatter's `slug`/`id`; `?force=true` bypasses the optimistic-concurrency conflict check. A site-scoped token may only import into its own sites.",
    auth: "pat-or-session",
    permission: "content:create",
    queryParams: [{ name: "force", type: "boolean", description: "Bypass the conflict check." }],
    body: {
      type: "object",
      properties: { raw: { type: "string", description: "The full file content, frontmatter + body." }, filename: { type: "string" } },
      required: ["raw"],
    },
    responses: [
      { status: 201, description: "New post created." },
      { status: 200, description: "Existing post updated." },
      { status: 409, description: "Conflict: the base hash in the frontmatter no longer matches (someone edited in the CMS since)." },
      { status: 400, description: "Malformed frontmatter or missing `raw`." },
    ],
    examples: [
      {
        title: "Import a new post from a Markdown file",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/posts/import\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"raw\":\"---\\ntitle: Imported From File\\nstatus: draft\\n---\\n\\nBody content from a Markdown file.\\n\",\"filename\":\"imported-from-file.md\"}'",
        response: {
          status: 201,
          body: {
            data: { id: "cmtyyfu2k0006trf6lt81di50", title: "Imported From File", slug: "imported-from-file", status: "draft" },
            created: true,
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/workflow",
    routeFile: "src/app/api/cms/posts/[id]/workflow/route.ts",
    group: "Posts",
    summary: "Advance a post through the review workflow",
    description:
      "draft → pending_review (`submit`) → `approve`/`reject`, or `publish`/`unpublish` directly for `content:publish` holders. Each action has its own permission and valid preceding state — see the 403/409 responses.",
    auth: "pat-or-session",
    permission: "content:view (plus an action-specific permission — see description)",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["submit", "approve", "reject", "publish", "unpublish"] },
        comments: { type: "string" },
        reason: { type: "string", description: "Used by `reject`; falls back to `comments`." },
      },
      required: ["action"],
    },
    responses: [
      { status: 200, description: "The post in its new state. For a token caller, `submit` and `publish` also return `humanizer`: `{ version, reviewed, warnings }`, the passages that read as AI-written (advisory, never a refusal)." },
      { status: 400, description: "Unknown or missing `action`." },
      { status: 403, description: "Missing the action's permission (`content:approve`/`content:reject`/`content:publish`), or not the post's own author for `submit`." },
      { status: 409, description: "The post isn't in the state the action requires (e.g. approving a non-pending post)." },
      RESPONSE_404,
      siteScopeResponse("change"),
    ],
    examples: [
      {
        title: "Submit a draft for review",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/workflow\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"action\":\"submit\"}'",
        response: { status: 200, body: { data: { id: "cmtyxp8le000ayof6g5jnv6l4", workflow_status: "pending_review" } } },
      },
      {
        title: "Approve it",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/workflow\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"action\":\"approve\",\"comments\":\"Looks good\"}'",
        response: {
          status: 200,
          body: { data: { id: "cmtyxp8le000ayof6g5jnv6l4", workflow_status: "approved", approved_by_id: "cmtyxp8h50002yof6qpeapon9" } },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/workflow",
    routeFile: "src/app/api/cms/posts/[id]/workflow/route.ts",
    group: "Posts",
    summary: "Get a post's approval history",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 200, description: "Every `ContentApproval` row for this post, newest first." }],
    examples: [
      {
        title: "Approval history",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/workflow\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyyfxc70007trf62djl56f5",
                post_id: "cmtyxp8le000ayof6g5jnv6l4",
                action: "approved",
                comments: "Looks good",
                reviewer: { id: "cmtyxp8h50002yof6qpeapon9", name: "API Docs Admin", email: "apidocs-admin@example.com" },
              },
            ],
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/resolve-conflict",
    routeFile: "src/app/api/cms/posts/[id]/resolve-conflict/route.ts",
    group: "Posts",
    summary: "Resolve a file-sync conflict by keeping the CMS version",
    description: "Clears `sync_conflict` and `last_synced_hash` so the next outbound sync sweep re-pushes the CMS's current content, overwriting the git side.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: { type: "object", properties: { expected_content_hash: { type: ["string", "null"] } } },
    responses: [{ status: 200, description: "The post with `sync_conflict: false`." }, RESPONSE_404, RESPONSE_CONTENT_HASH_CONFLICT, siteScopeResponse("change")],
    examples: [
      {
        title: "Keep the CMS version",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi/resolve-conflict\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{}'",
        response: { status: 200, body: { data: { id: "cmtyxp8kn0009yof6u7xh6cpi", sync_conflict: false, last_synced_hash: null } } },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/revisions",
    routeFile: "src/app/api/cms/posts/[id]/revisions/route.ts",
    group: "Posts",
    summary: "Save a labelled checkpoint of a post",
    description:
      "Snapshots the post as it is now under a label (\"Before rewriting the intro\"), so a big change is one restore away. Labelled checkpoints are exempt from age-based thinning. If the newest revision already holds exactly this state it is labelled and returned (200) rather than duplicated.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: {
      type: "object",
      properties: { label: { type: "string", maxLength: 200 } },
      required: ["label"],
    },
    responses: [
      { status: 201, description: "The new checkpoint's metadata." },
      { status: 200, description: "The newest revision already matched; it now carries the label." },
      { status: 400, description: "Missing label, or longer than 200 characters." },
      RESPONSE_404,
      { status: 403, description: "Not the post's own author (needs `content:edit_any`), or a site-scope refusal." },
    ],
    examples: [
      {
        title: "Checkpoint before a rewrite",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/revisions\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{\"label\":\"Before rewriting the intro\"}'",
        response: {
          status: 201,
          body: {
            data: {
              id: "cmu0rev0000000000000000001",
              title: "Hello world",
              source: "checkpoint",
              label: "Before rewriting the intro",
              edited_by: { id: "cmu0usr0000000000000000001", name: "Ada Writer", email: "ada@example.com" },
              inserted_at: "2026-09-23T18:00:00.000Z",
            },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/revisions",
    routeFile: "src/app/api/cms/posts/[id]/revisions/route.ts",
    group: "Posts",
    summary: "List a post's revision history (metadata only)",
    description: "Paginated, newest first; no `content`/`content_html` bodies — fetch a single revision for the full snapshot.",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    queryParams: [
      { name: "page", type: "integer", description: "Default 1." },
      { name: "per_page", type: "integer", description: "Default 50, capped at 100." },
    ],
    responses: [{ status: 200, description: "A page of revision metadata." }, RESPONSE_404, siteScopeResponse("read")],
    examples: [
      {
        title: "List revisions",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi/revisions\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyyfl8q0005trf6ddbdv84p",
                title: "Announcing the API Docs Foundation",
                source: "api",
                edited_by: { id: "cmtyxp8h50002yof6qpeapon9", name: "API Docs Admin", email: "apidocs-admin@example.com" },
                inserted_at: "2026-09-12T22:26:22.154Z",
              },
            ],
            meta: { total: 1, page: 1, per_page: 50 },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/revisions/{revisionId}",
    routeFile: "src/app/api/cms/posts/[id]/revisions/[revisionId]/route.ts",
    group: "Posts",
    summary: "Get one revision's full snapshot",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [
      { name: "id", type: "string", required: true, description: "The post's database id." },
      { name: "revisionId", type: "string", required: true, description: "The revision's id." },
    ],
    responses: [{ status: 200, description: "The full revision, including content and content_html." }, RESPONSE_404],
    examples: [
      {
        title: "Fetch one revision",
        curl:
          "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi/revisions/cmtyyfl8q0005trf6ddbdv84p\"",
        response: {
          status: 200,
          body: {
            data: {
              id: "cmtyyfl8q0005trf6ddbdv84p",
              post_id: "cmtyxp8kn0009yof6u7xh6cpi",
              title: "Announcing the API Docs Foundation",
              content: "# Hello\n\nThis is a **published** post used to generate real API examples.",
              source: "api",
              edited_by: { id: "cmtyxp8h50002yof6qpeapon9", name: "API Docs Admin", email: "apidocs-admin@example.com" },
            },
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/revisions/{revisionId}/restore",
    routeFile: "src/app/api/cms/posts/[id]/revisions/[revisionId]/restore/route.ts",
    group: "Posts",
    summary: "Restore a post to an earlier revision",
    description: "The post's CURRENT state is snapshotted first (`source: \"restore\"`), so a restore is itself always undoable.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [
      { name: "id", type: "string", required: true, description: "The post's database id." },
      { name: "revisionId", type: "string", required: true, description: "The revision to restore." },
    ],
    body: { type: "object", properties: { expected_content_hash: { type: ["string", "null"] } } },
    responses: [{ status: 200, description: "The restored post." }, RESPONSE_404, RESPONSE_CONTENT_HASH_CONFLICT, siteScopeResponse("change")],
    examples: [
      {
        title: "Restore a revision",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi/revisions/cmtyyfl8q0005trf6ddbdv84p/restore\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{}'",
        response: {
          status: 200,
          body: {
            data: {
              id: "cmtyxp8kn0009yof6u7xh6cpi",
              title: "Announcing the API Docs Foundation",
              content: "# Hello\n\nThis is a **published** post used to generate real API examples.",
              excerpt: "A short excerpt for the fixture post.",
            },
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/preview-link",
    routeFile: "src/app/api/cms/posts/[id]/preview-link/route.ts",
    group: "Posts",
    summary: "Mint (or refresh) a signed preview link",
    description: "Gated the same as editing the post — minting a link hands out read access to unpublished content. The link expires in 7 days and replacing it invalidates any previously issued token for this post.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [
      { status: 200, description: "The signed preview URL and its expiry." },
      RESPONSE_404,
      { status: 403, description: "Not the post's own author (needs `content:edit_any`), or a site-scope refusal." },
    ],
    examples: [
      {
        title: "Mint a preview link",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/preview-link\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{}'",
        response: {
          status: 200,
          body: {
            data: {
              url: "https://cms.interactor.com/preview/Y210eXhwOGxlMDAwYXlvZjZnNWpudjZsNC4xNzg5ODU2ODI0NjYwLmdoY2VwQVg5b2pIbHU0S1NLVUJwRGJaeUNQckdHZUhrUktleEJWeDRfYUU",
              expires_at: "2026-09-19T22:27:04.660Z",
            },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/posts/{id}/seo-check",
    routeFile: "src/app/api/cms/posts/[id]/seo-check/route.ts",
    group: "Posts",
    summary: "Search & AI readiness check (G#32)",
    description:
      "The same check the publish/approve workflow actions gate on (src/lib/seo-readiness.ts): `errors` (meta " +
      "description length, effective title length, slug format, no `<h1>` in body, image alt text, " +
      "answer_summary length, heading-level skips) block that transition; `warnings` (question-phrased H2s, " +
      "internal/outbound links, a cited statistic, a definitional opening sentence, a duplicate title " +
      "elsewhere in the org, title/meta near-duplication) are advisory only. Read-only, and an existing " +
      "published post is never retro-blocked by calling this — only the workflow gate refuses a transition. " +
      "Warnings whose key starts with `humanizer_` are passages that read as AI-written (src/lib/humanizer): " +
      "text rules always, plus a model review against the Humanizer rules (`humanizer_review`) when an AI key " +
      "is configured. `humanizer.reviewed` says whether that review ran; `?humanizer_review=false` skips it.",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [
      { status: 200, description: "The readiness result." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Check a post's readiness",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/seo-check\"",
        response: {
          status: 200,
          body: {
            data: {
              errors: [
                { key: "answer_summary_length", message: "Answer summary should be 25-80 words (currently 0)." },
              ],
              warnings: [
                { key: "no_statistic", message: "No statistic or number with context found — cited data raises AI-answer visibility." },
              ],
            },
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/writer-list",
    routeFile: "src/app/api/cms/writer-list/route.ts",
    group: "Posts",
    summary: "Open the writer's post list (Interactor CMS plugin)",
    description:
      "Backs the `open_post_list` MCP tool. Returns `list_url`: the writer's post list page with a short-lived browse key in its URL fragment, for Claude to open in the app's browser panel, where clicking a post opens it in the editor. The key lists this organization's posts (narrowed to `site` and the token's site scope) and opens them, nothing else; it expires in 8 hours, ends when the minting token is revoked, and replaces the caller's previous list key.",
    auth: "pat-or-session",
    permission: "content:view",
    body: {
      type: "object",
      properties: { site: { type: "string" }, search: { type: "string", maxLength: 200 } },
    },
    responses: [
      { status: 200, description: "`list_url`, the site it shows, and the key's expiry." },
      { status: 400, description: "Unknown site." },
      { status: 403, description: "The site is outside the token's site scope." },
    ],
    examples: [
      {
        title: "Open the post list for one site",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/writer-list\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{\"site\":\"website\"}'",
        response: {
          status: 200,
          body: {
            data: {
              list_url: "https://cms.interactor.com/write/posts#key=cms_list_...",
              site: "website",
              expires_at: "2026-09-24T08:00:00.000Z",
            },
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/edit-session",
    routeFile: "src/app/api/cms/posts/[id]/edit-session/route.ts",
    group: "Posts",
    summary: "Open a post for live editing (Interactor CMS plugin)",
    description:
      "Backs the `open_for_editing` MCP tool. Returns the post's live preview link (reusing an active one), a one-post edit key for the plugin's local sync tool, and `editor_url`, the writer editor (the post formatted and typed on directly) with the key in its URL fragment. The key authenticates only `/api/edit/*`, only for this post, expires in 8 hours, ends when the minting token is revoked, and replaces any key the caller already held for the post. `editor_url` also carries a post-list key (`&list=`) for the editor's \"All posts\" link; an optional JSON body `{ \"site\": \"<slug>\" }` narrows that list to one site.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [
      { status: 200, description: "Preview URL, edit key and its expiry, and the sync file URL." },
      RESPONSE_404,
      { status: 403, description: "Not the post's own author (needs `content:edit_any`), or a site-scope refusal." },
    ],
    examples: [
      {
        title: "Open a post for editing",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/edit-session\" -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 200,
          body: {
            data: {
              post: { id: "cmtyxp8le000ayof6g5jnv6l4", slug: "hello-world", title: "Hello world" },
              filename: "hello-world.md",
              preview_url: "https://cms.interactor.com/preview/Y210eXhwOGxl...",
              edit_key: "cms_edit_...",
              edit_key_expires_at: "2026-09-24T02:00:00.000Z",
              file_url: "https://cms.interactor.com/api/edit/file",
              editor_url: "https://cms.interactor.com/write#key=cms_edit_...&list=cms_list_...",
            },
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/posts/{id}/featured-image",
    routeFile: "src/app/api/cms/posts/[id]/featured-image/route.ts",
    group: "Posts",
    summary: "Generate a title-card featured image",
    description:
      "Renders a 1200×630 title card (post title, category, organization, author) on the CMS server — no image model, no third-party service, no cost — stores it in the media library, and sets it as the post's `featured_image`. Replaces an existing featured image; sets `featured_image_alt` only when it is empty. Publishing a post that has no featured image does this automatically, so call this only to preview or refresh the card.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [
      { status: 201, description: "The post's new `featured_image`/`featured_image_alt` and the created media id." },
      RESPONSE_404,
      { status: 403, description: "Not the post's own author (needs `content:edit_any`), or a site-scope refusal." },
      { status: 502, description: "Rendering or storage failed; the post is unchanged." },
    ],
    examples: [
      {
        title: "Generate a featured image",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/featured-image\" -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 201,
          body: {
            data: {
              id: "cmtyxp8le000ayof6g5jnv6l4",
              featured_image: "https://interactor-media.s3.amazonaws.com/uploads/1790802834704-hello-world-featured.png",
              featured_image_alt: "Title card reading \"Hello, world\"",
              media_id: "cmuelojym0009wrs6abcd1234",
            },
          },
        },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/posts/{id}/preview-link",
    routeFile: "src/app/api/cms/posts/[id]/preview-link/route.ts",
    group: "Posts",
    summary: "Revoke a post's active preview link",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    responses: [{ status: 204, description: "Revoked (or there was none)." }, RESPONSE_404],
    examples: [
      {
        title: "Revoke a preview link",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/posts/cmtyxp8le000ayof6g5jnv6l4/preview-link\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
    ],
  },
  {
    method: "PATCH",
    path: "/api/cms/posts/{id}/content",
    routeFile: "src/app/api/cms/posts/[id]/content/route.ts",
    group: "Posts",
    summary: "Anchored find/replace edit of a post's content",
    description:
      "A token-cheaper alternative to PUT for a small, localized change. Every `find` anchor must match `expected_occurrences` times (default 1, applied in order — a later anchor may target text an earlier replacement just introduced); a zero-match or ambiguous anchor refuses the WHOLE call with a 400 naming which replacement failed and how many matches it found, before anything is written.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The post's database id." }],
    body: {
      type: "object",
      properties: {
        replacements: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              find: { type: "string", minLength: 1 },
              replace: { type: "string" },
              expected_occurrences: { type: "integer", minimum: 1, default: 1 },
            },
            required: ["find", "replace"],
          },
        },
        expected_content_hash: { type: ["string", "null"] },
      },
      required: ["replacements"],
    },
    responses: [
      { status: 200, description: "The post with the replacements applied (or unchanged, if the replacements were a no-op)." },
      { status: 400, description: "A replacement's anchor matched the wrong number of times; names which one and how many matches were found." },
      RESPONSE_404,
      RESPONSE_CONTENT_HASH_CONFLICT,
      siteScopeResponse("change"),
    ],
    examples: [
      {
        title: "Apply an anchored replacement",
        curl:
          "curl -X PATCH \"https://cms.interactor.com/api/cms/posts/cmtyxp8kn0009yof6u7xh6cpi/content\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"replacements\":[{\"find\":\"Hello\",\"replace\":\"Hello there\"}]}'",
        response: {
          status: 200,
          body: { data: { id: "cmtyxp8kn0009yof6u7xh6cpi", content: "# Hello there\n\nThis is a **published** post used to generate real API examples." } },
        },
      },
      {
        title: "Ambiguous anchor (3 matches, expected 1)",
        curl:
          "curl -X PATCH \"https://cms.interactor.com/api/cms/posts/cmtyyviqt0002x0f62wmsfezm/content\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"replacements\":[{\"find\":\"cat\",\"replace\":\"dog\"}]}'",
        response: {
          status: 400,
          body: {
            error: "Replacement 0 found 3 match(es) for its anchor, expected 1 — no changes were applied",
            index: 0,
            find: "cat",
            expected_occurrences: 1,
            found_occurrences: 3,
          },
        },
      },
    ],
  },
];

// ─── Categories ─────────────────────────────────────────────────────────────

const CATEGORY_BODY_SCHEMA: DocSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    slug: { type: "string", description: "Defaults to a slugified name." },
    description: { type: "string" },
    color: { type: "string" },
    sort_order: { type: "integer", default: 0 },
  },
};

const CATEGORIES_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/categories",
    routeFile: "src/app/api/cms/categories/route.ts",
    group: "Categories",
    summary: "List categories",
    auth: "pat-or-session",
    permission: "content:view",
    responses: [{ status: 200, description: "Every category, sorted by sort_order then name." }],
    examples: [
      {
        title: "List categories",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/categories\"",
        response: {
          status: 200,
          body: { data: [{ id: "cmtyxp8il0006yof66fgkf2b5", name: "Product Updates", slug: "product-updates", description: "Release notes and product news" }] },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/categories",
    routeFile: "src/app/api/cms/categories/route.ts",
    group: "Categories",
    summary: "Create a category",
    auth: "pat-or-session",
    permission: "categories:manage",
    body: { ...CATEGORY_BODY_SCHEMA, required: ["name"] },
    responses: [{ status: 201, description: "The created category." }, { status: 409, description: "A category with this name or slug already exists." }],
    examples: [
      {
        title: "Create a category",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/categories\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"name\":\"Throwaway Category\"}'",
        response: { status: 201, body: { data: { id: "cmtyyglwl000atrf6g12cxn2y", name: "Throwaway Category", slug: "throwaway-category" } } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/categories/{id}",
    routeFile: "src/app/api/cms/categories/[id]/route.ts",
    group: "Categories",
    summary: "Get one category",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The category's id." }],
    responses: [{ status: 200, description: "The category." }, RESPONSE_404],
    examples: [
      {
        title: "Fetch a category",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/categories/cmtyxp8il0006yof66fgkf2b5\"",
        response: { status: 200, body: { data: { id: "cmtyxp8il0006yof66fgkf2b5", name: "Product Updates", slug: "product-updates" } } },
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/cms/categories/{id}",
    routeFile: "src/app/api/cms/categories/[id]/route.ts",
    group: "Categories",
    summary: "Update a category",
    auth: "pat-or-session",
    permission: "categories:manage",
    pathParams: [{ name: "id", type: "string", required: true, description: "The category's id." }],
    body: CATEGORY_BODY_SCHEMA,
    responses: [{ status: 200, description: "The updated category." }, RESPONSE_404, { status: 409, description: "Name/slug collision." }],
    examples: [
      {
        title: "Update a category's description",
        curl:
          "curl -X PUT \"https://cms.interactor.com/api/cms/categories/cmtyyglwl000atrf6g12cxn2y\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"description\":\"Updated description\"}'",
        response: { status: 200, body: { data: { id: "cmtyyglwl000atrf6g12cxn2y", description: "Updated description" } } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/categories/{id}",
    routeFile: "src/app/api/cms/categories/[id]/route.ts",
    group: "Categories",
    summary: "Delete a category",
    auth: "pat-or-session",
    permission: "categories:manage",
    pathParams: [{ name: "id", type: "string", required: true, description: "The category's id." }],
    responses: [{ status: 204, description: "Deleted." }],
    examples: [
      {
        title: "Delete a category",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/categories/cmtyyglwl000atrf6g12cxn2y\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
    ],
  },
];

// ─── Tags ───────────────────────────────────────────────────────────────────

const TAGS_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/tags",
    routeFile: "src/app/api/cms/tags/route.ts",
    group: "Tags",
    summary: "List tags in use",
    description: "A tag is nothing but the posts carrying it — this is the distinct set across posts the caller can see (filtered by site scope for a scoped token).",
    auth: "pat-or-session",
    permission: "content:view",
    queryParams: [{ name: "q", type: "string", description: "Case-insensitive substring filter." }],
    responses: [{ status: 200, description: "Sorted list of matching tag strings." }],
    examples: [
      {
        title: "Search tags",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/tags?q=doc\"",
        response: { status: 200, body: { tags: ["docs"] } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/tags",
    routeFile: "src/app/api/cms/tags/route.ts",
    group: "Tags",
    summary: "Remove a tag from every post carrying it",
    description: "Rewrites every matching post's `tags` array, so it needs `content:edit_any`. A site-scoped token's request is refused whole if the tag appears on any out-of-scope post.",
    auth: "pat-or-session",
    permission: "content:edit_any",
    queryParams: [{ name: "tag", type: "string", required: true, description: "The exact tag to remove." }],
    responses: [
      { status: 204, description: "Removed from every post that had it." },
      { status: 400, description: "Missing `tag` query param." },
      { status: 403, description: "Site-scope batch refusal, naming the out-of-scope posts." },
    ],
    examples: [
      {
        title: "Delete a tag",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/tags?tag=temp-doc-tag\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
    ],
  },
];

// ─── Media ──────────────────────────────────────────────────────────────────

const MEDIA_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/media",
    routeFile: "src/app/api/cms/media/route.ts",
    group: "Media",
    summary: "List media",
    auth: "pat-or-session",
    permission: "media:view",
    responses: [{ status: 200, description: "Every media row, newest first." }],
    examples: [
      {
        title: "List media",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/media\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyxp8my000dyof66u96lqug",
                filename: "fixture-image.png",
                original_filename: "fixture-image.png",
                file_path: "/uploads/fixture-image.png",
                file_size: 1024,
                mime_type: "image/png",
                alt_text: "Fixture image",
              },
            ],
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/media",
    routeFile: "src/app/api/cms/media/route.ts",
    group: "Media",
    summary: "Upload a media file",
    description: "`multipart/form-data`. Stored on S3 in production; falls back to local `public/uploads` in dev when AWS credentials are absent. Image dimensions are probed best-effort.",
    auth: "pat-or-session",
    permission: "media:upload",
    bodyContentType: "multipart/form-data",
    body: {
      type: "object",
      description: "multipart/form-data fields",
      properties: {
        file: { type: "string", format: "binary", description: "The file to upload." },
        alt_text: { type: "string" },
        caption: { type: "string" },
      },
      required: ["file"],
    },
    responses: [{ status: 201, description: "The created media row." }, { status: 400, description: "No file provided." }],
    examples: [
      {
        title: "Upload a file",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/media\" -H \"Authorization: Bearer cms_pat_...\" \\\n" +
          "  -F \"file=@photo.png;type=image/png\" -F \"alt_text=A fixture image\"",
        response: {
          status: 201,
          body: {
            data: {
              id: "cmtyygqcn000btrf6n8shd4xv",
              filename: "1789252035358-fixture-upload.png",
              original_filename: "fixture-upload.png",
              file_path: "/uploads/1789252035358-fixture-upload.png",
              mime_type: "image/png",
              alt_text: "A fixture image",
            },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/media/{id}",
    routeFile: "src/app/api/cms/media/[id]/route.ts",
    group: "Media",
    summary: "Get one media row",
    auth: "pat-or-session",
    permission: "media:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The media row's id." }],
    responses: [{ status: 200, description: "The media row." }, RESPONSE_404],
    examples: [
      {
        title: "Fetch a media row",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/media/cmtyxp8my000dyof66u96lqug\"",
        response: { status: 200, body: { data: { id: "cmtyxp8my000dyof66u96lqug", filename: "fixture-image.png" } } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/media/{id}",
    routeFile: "src/app/api/cms/media/[id]/route.ts",
    group: "Media",
    summary: "Delete a media row (and its underlying file)",
    auth: "pat-or-session",
    permission: "media:delete",
    pathParams: [{ name: "id", type: "string", required: true, description: "The media row's id." }],
    responses: [{ status: 204, description: "Deleted." }, RESPONSE_404],
    examples: [
      {
        title: "Delete a media row",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/media/cmtyygqcn000btrf6n8shd4xv\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
    ],
  },
];

// ─── FAQs ───────────────────────────────────────────────────────────────────

const FAQ_BODY_SCHEMA: DocSchema = {
  type: "object",
  properties: {
    question: { type: "string" },
    answer: { type: "string" },
    slug: { type: "string", description: "Defaults to a slugified question." },
    category: { type: "string", enum: [...FAQ_CATEGORIES] },
    audience: { type: "string", enum: [...FAQ_AUDIENCES], default: "sales-only" },
    status: { type: "string", enum: [...FAQ_STATUSES], default: "draft", description: "Publishing requires `content:publish`; otherwise the FAQ is saved as a draft even if `published` is requested." },
    last_verified: { type: ["string", "null"], format: "date-time" },
    verify_every_days: { type: "integer", default: 365 },
    sources: { type: "array", items: { type: "string" } },
    related: { type: "array", items: { type: "string" }, description: "Slugs of other FAQ entries." },
  },
};

const FAQS_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/faqs",
    routeFile: "src/app/api/cms/faqs/route.ts",
    group: "FAQs",
    summary: "List FAQ entries",
    description: "Reuses the Post content type's permission set (`content:view`/`create`/...) rather than a parallel `faq:*` set. `?status=published` is readable by any signed-in caller; any other filter (or none) requires `content:view`.",
    auth: "pat-or-session",
    permission: "content:view (unless ?status=published)",
    queryParams: [
      { name: "status", type: "string", description: `One of: ${FAQ_STATUSES.join(", ")}.` },
      { name: "category", type: "string", description: `One of: ${FAQ_CATEGORIES.join(", ")}.` },
      { name: "audience", type: "string", description: `One of: ${FAQ_AUDIENCES.join(", ")}.` },
    ],
    responses: [{ status: 200, description: "Matching FAQ entries." }],
    examples: [
      {
        title: "List published FAQs",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/faqs?status=published\"",
        response: {
          status: 200,
          body: {
            data: [
              {
                id: "cmtyxp8m4000byof69fkfsnzw",
                slug: "what-is-the-api-docs-foundation",
                question: "What is the API docs foundation?",
                category: "self-hosting",
                audience: "public",
                status: "published",
              },
            ],
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/faqs",
    routeFile: "src/app/api/cms/faqs/route.ts",
    group: "FAQs",
    summary: "Create a FAQ entry",
    auth: "pat-or-session",
    permission: "content:create",
    body: { ...FAQ_BODY_SCHEMA, required: ["question", "answer", "category"] },
    responses: [
      { status: 201, description: "Created. Carries a `warning` instead of erroring if `published` was requested without `content:publish`." },
      { status: 400, description: "Missing question/answer, or an invalid category/audience/status." },
      { status: 409, description: "A FAQ with this slug already exists." },
    ],
    examples: [
      {
        title: "Create a FAQ",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/faqs\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"question\":\"Is there a throwaway FAQ?\",\"answer\":\"Yes, for docs.\",\"category\":\"ci\"}'",
        response: {
          status: 201,
          body: { data: { id: "cmtyygtuy000ctrf6brww2pt4", slug: "is-there-a-throwaway-faq", question: "Is there a throwaway FAQ?", status: "draft" } },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/faqs/{id}",
    routeFile: "src/app/api/cms/faqs/[id]/route.ts",
    group: "FAQs",
    summary: "Get one FAQ entry, with its answer revision history",
    auth: "pat-or-session",
    permission: "content:view",
    pathParams: [{ name: "id", type: "string", required: true, description: "The FAQ's database id." }],
    responses: [{ status: 200, description: "The FAQ, including `revisions`." }, RESPONSE_404],
    examples: [
      {
        title: "Fetch a FAQ",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/faqs/cmtyxp8m4000byof69fkfsnzw\"",
        response: { status: 200, body: { data: { id: "cmtyxp8m4000byof69fkfsnzw", question: "What is the API docs foundation?", revisions: [] } } },
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/cms/faqs/{id}",
    routeFile: "src/app/api/cms/faqs/[id]/route.ts",
    group: "FAQs",
    summary: "Update a FAQ entry",
    description: "A change to `answer` snapshots the OUTGOING answer into `FaqRevision` first. A status transition to/from `published` without `content:publish` is silently dropped (the rest of the update still applies).",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The FAQ's database id." }],
    body: FAQ_BODY_SCHEMA,
    responses: [{ status: 200, description: "The updated FAQ." }, RESPONSE_404, { status: 409, description: "Slug collision." }],
    examples: [
      {
        title: "Update a FAQ's answer",
        curl:
          "curl -X PUT \"https://cms.interactor.com/api/cms/faqs/cmtyygtuy000ctrf6brww2pt4\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"answer\":\"Yes indeed, updated answer.\"}'",
        response: { status: 200, body: { data: { id: "cmtyygtuy000ctrf6brww2pt4", answer: "Yes indeed, updated answer." } } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/faqs/{id}",
    routeFile: "src/app/api/cms/faqs/[id]/route.ts",
    group: "FAQs",
    summary: "Delete a FAQ entry",
    auth: "pat-or-session",
    permission: "content:delete",
    pathParams: [{ name: "id", type: "string", required: true, description: "The FAQ's database id." }],
    responses: [{ status: 204, description: "Deleted." }],
    examples: [
      {
        title: "Delete a FAQ",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/faqs/cmtyygtuy000ctrf6brww2pt4\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
    ],
  },
];

// ─── Content types ──────────────────────────────────────────────────────────

const CONTENT_TYPES_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/content-types",
    routeFile: "src/app/api/cms/content-types/route.ts",
    group: "Content types",
    summary: "List the organization's content-type registry",
    description: "Merges registered rows with built-in seeds (blog/news/announcement/article) and any type already in use but never registered — for discoverability, not enforcement (`Post.type` carries no FK to this table).",
    auth: "pat-or-session",
    permission: "content:view",
    responses: [{ status: 200, description: "The merged list." }],
    examples: [
      {
        title: "List content types",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/content-types\"",
        response: {
          status: 200,
          body: {
            data: [
              { id: "builtin:blog", slug: "blog", name: "Blog" },
              { id: "cmtyxp8it0007yof626j6i4tk", slug: "release-note", name: "Release note", description: "A short release announcement" },
            ],
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/content-types",
    routeFile: "src/app/api/cms/content-types/route.ts",
    group: "Content types",
    summary: "Register a content type",
    auth: "pat-or-session",
    permission: "categories:manage",
    body: {
      type: "object",
      properties: { slug: TYPE_SCHEMA, name: { type: "string", description: "Defaults to a title-cased slug." }, description: { type: "string" }, sort_order: { type: "integer", default: 100 } },
      required: ["slug"],
    },
    responses: [
      { status: 201, description: "The created content type." },
      { status: 400, description: "Invalid slug (must be lowercase kebab-case)." },
      { status: 409, description: "A content type with this name or slug already exists." },
    ],
    examples: [
      {
        title: "Register a content type",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/content-types\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"slug\":\"case-study\"}'",
        response: { status: 201, body: { data: { id: "cmtyygxjk000etrf6vytqqtgt", slug: "case-study", name: "Case Study", sort_order: 100 } } },
      },
    ],
  },
];

// ─── Sites ──────────────────────────────────────────────────────────────────

const SITES_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/sites",
    routeFile: "src/app/api/cms/sites/route.ts",
    group: "Sites",
    summary: "List the organization's distribution-target registry",
    description: "Merges registered rows with built-in seeds (`website`) and any slug already in use on a post but never registered.",
    auth: "pat-or-session",
    permission: "content:view",
    responses: [{ status: 200, description: "The merged list." }],
    examples: [
      {
        title: "List sites",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/sites\"",
        response: {
          status: 200,
          body: {
            data: [
              { id: "builtin:website", slug: "website", name: "Interactor Website" },
              { id: "cmtyxp8k00008yof6dnkzb05g", slug: "product-manager", name: "Product Manager", description: "product-manager's Blog section" },
            ],
          },
        },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/sites",
    routeFile: "src/app/api/cms/sites/route.ts",
    group: "Sites",
    summary: "Register a distribution target",
    auth: "pat-or-session",
    permission: "categories:manage",
    body: {
      type: "object",
      properties: { slug: SITE_SLUG_SCHEMA, name: { type: "string", description: "Defaults to a title-cased slug." }, description: { type: "string" }, sort_order: { type: "integer", default: 100 } },
      required: ["slug"],
    },
    responses: [
      { status: 201, description: "The created site." },
      { status: 400, description: "Invalid slug." },
      { status: 409, description: "A site with this name or slug already exists." },
    ],
    examples: [
      {
        title: "Register a site",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/cms/sites\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"slug\":\"partner-portal\"}'",
        response: { status: 201, body: { data: { id: "cmtyygy1t000ftrf6as76ljpu", slug: "partner-portal", name: "Partner Portal", sort_order: 100 } } },
      },
    ],
  },
  {
    method: "PUT",
    path: "/api/cms/sites/{id}",
    routeFile: "src/app/api/cms/sites/[id]/route.ts",
    group: "Sites",
    summary: "Rename or update a site",
    description: "A built-in seed has no row here (its id is `builtin:<slug>`), so it 404s — registering a row with the same slug is how an org overrides a seed.",
    auth: "pat-or-session",
    permission: "categories:manage",
    pathParams: [{ name: "id", type: "string", required: true, description: "The site's database id (not `builtin:...`)." }],
    body: {
      type: "object",
      properties: { slug: SITE_SLUG_SCHEMA, name: { type: "string" }, description: { type: "string" }, sort_order: { type: "integer" } },
    },
    responses: [{ status: 200, description: "The updated site." }, RESPONSE_404, { status: 409, description: "Name/slug collision." }],
    examples: [
      {
        title: "Update a site's description",
        curl:
          "curl -X PUT \"https://cms.interactor.com/api/cms/sites/cmtyygy1t000ftrf6as76ljpu\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"description\":\"A partner-facing distribution target\"}'",
        response: { status: 200, body: { data: { id: "cmtyygy1t000ftrf6as76ljpu", description: "A partner-facing distribution target" } } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/sites/{id}",
    routeFile: "src/app/api/cms/sites/[id]/route.ts",
    group: "Sites",
    summary: "Remove a site from the registry",
    description: "Refuses while any post still targets the slug — `Post.platforms` carries no FK, so nothing else would stop a post from silently pointing at a site the editor no longer offers.",
    auth: "pat-or-session",
    permission: "categories:manage",
    pathParams: [{ name: "id", type: "string", required: true, description: "The site's database id." }],
    responses: [
      { status: 204, description: "Removed." },
      RESPONSE_404,
      { status: 409, description: "One or more posts still target this site." },
    ],
    examples: [
      {
        title: "Remove an unused site",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/sites/cmtyygy1t000ftrf6as76ljpu\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 204 },
      },
      {
        title: "Removing a site still in use",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/sites/cmtyxp8k00008yof6dnkzb05g\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 409, body: { error: "1 post still target \"Product Manager\". Retarget them before removing it." } },
      },
    ],
  },
];

// ─── Comments (admin moderation) ────────────────────────────────────────────

const COMMENTS_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/comments",
    routeFile: "src/app/api/cms/comments/route.ts",
    group: "Comments",
    summary: "List comments for moderation",
    description: "Matches the admin gating used for the other submission-review surfaces (`admin:access`) rather than a `content:*` permission. Note: the response is a bare array, not `{ data: [...] }`.",
    auth: "pat-or-session",
    permission: "admin:access",
    queryParams: [{ name: "status", type: "string", description: "`pending` | `published` | `spam` | `rejected`." }],
    responses: [{ status: 200, description: "A bare array of comments, newest first." }],
    examples: [
      {
        title: "List pending comments",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/comments?status=pending\"",
        response: {
          status: 200,
          body: [
            {
              id: "cmtyxp8mo000cyof6cwhs60jl",
              postId: "cmtyxp8kn0009yof6u7xh6cpi",
              postTitle: "Announcing the API Docs Foundation",
              authorName: "A Reader",
              authorEmail: "reader@example.com",
              content: "Great post!",
              status: "pending",
            },
          ],
        },
      },
    ],
  },
  {
    method: "PATCH",
    path: "/api/cms/comments/{id}",
    routeFile: "src/app/api/cms/comments/[id]/route.ts",
    group: "Comments",
    summary: "Moderate a comment's status",
    auth: "pat-or-session",
    permission: "admin:access",
    pathParams: [{ name: "id", type: "string", required: true, description: "The comment's id." }],
    body: {
      type: "object",
      properties: { status: { type: "string", enum: ["pending", "published", "spam", "rejected"] } },
      required: ["status"],
    },
    responses: [
      { status: 200, description: "`{ id, status }`." },
      { status: 400, description: "Invalid status." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Publish a comment",
        curl:
          "curl -X PATCH \"https://cms.interactor.com/api/cms/comments/cmtyxp8mo000cyof6cwhs60jl\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"status\":\"published\"}'",
        response: { status: 200, body: { id: "cmtyxp8mo000cyof6cwhs60jl", status: "published" } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/comments/{id}",
    routeFile: "src/app/api/cms/comments/[id]/route.ts",
    group: "Comments",
    summary: "Delete a comment",
    auth: "pat-or-session",
    permission: "admin:access",
    pathParams: [{ name: "id", type: "string", required: true, description: "The comment's id." }],
    responses: [{ status: 200, description: "`{ success: true }` — 200 even if nothing matched." }],
    examples: [
      {
        title: "Delete a comment",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/comments/cmtyyh46p000gtrf6ckm8c33q\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 200, body: { success: true } },
      },
    ],
  },
];

// ─── Tokens (session-only — deliberately not reachable by a PAT) ───────────

const TOKENS_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/tokens",
    routeFile: "src/app/api/cms/tokens/route.ts",
    group: "Tokens",
    summary: "List the caller's own personal access tokens",
    description:
      "Session-only by design — a leaked token must never be usable to enumerate, mint, or revoke other tokens. A `cms_pat_...` bearer here is refused with the same 401 as no credential at all.",
    auth: "session-only",
    responses: [{ status: 200, description: "The caller's tokens (never the secret, only `token_prefix`)." }, RESPONSE_401],
    examples: [
      {
        title: "A personal access token is refused here",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/tokens\"",
        response: { status: 401, body: { error: "Unauthorized" } },
      },
    ],
  },
  {
    method: "POST",
    path: "/api/cms/tokens",
    routeFile: "src/app/api/cms/tokens/route.ts",
    group: "Tokens",
    summary: "Mint a new personal access token",
    description: "Session-only, for the same reason as GET. The raw token is returned exactly once, in this response.",
    auth: "session-only",
    body: {
      type: "object",
      properties: {
        name: { type: "string" },
        organization_id: { type: "string", description: "Defaults to the session's active org; must be one of the caller's own memberships." },
        site_scopes: { type: "array", items: { type: "string" }, description: "Defaults to unscoped (every site in the org)." },
        expires_in_days: { type: "number" },
      },
      required: ["name"],
    },
    responses: [
      { status: 201, description: "`{ data: { ...token metadata, token: \"cms_pat_...\" } }`." },
      { status: 400, description: "Missing name, or an unknown site slug." },
      { status: 403, description: "`organization_id` names an org the caller doesn't belong to." },
      RESPONSE_401,
    ],
    examples: [
      {
        title: "A personal access token is refused here",
        curl: "curl -X POST \"https://cms.interactor.com/api/cms/tokens\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" -d '{\"name\":\"x\"}'",
        response: { status: 401, body: { error: "Unauthorized" } },
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/cms/tokens/{id}",
    routeFile: "src/app/api/cms/tokens/[id]/route.ts",
    group: "Tokens",
    summary: "Revoke a personal access token",
    description: "Session-only. Revokes (keeps the audit row) rather than deleting. Only the token's own owner may revoke it.",
    auth: "session-only",
    pathParams: [{ name: "id", type: "string", required: true, description: "The token's id." }],
    responses: [{ status: 204, description: "Revoked." }, RESPONSE_404, RESPONSE_401],
    examples: [
      {
        title: "A personal access token is refused here",
        curl: "curl -X DELETE \"https://cms.interactor.com/api/cms/tokens/cmtyxp8n2000eyof6atc041kn\" -H \"Authorization: Bearer cms_pat_...\"",
        response: { status: 401, body: { error: "Unauthorized" } },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/cms/tokens/sites",
    routeFile: "src/app/api/cms/tokens/sites/route.ts",
    group: "Tokens",
    summary: "List the sites a new token for an organization may be scoped to",
    description: "Session-only. Backs the token-minting dialog's site picker — answers for `?organization_id=`, not the caller's active org, so a multi-org user picking another org in the dialog sees the right list.",
    auth: "session-only",
    queryParams: [{ name: "organization_id", type: "string", description: "Defaults to the session's active org." }],
    responses: [{ status: 200, description: "The named organization's sites." }, { status: 403, description: "Not a member of that organization." }, RESPONSE_401],
    examples: [
      {
        title: "A personal access token is refused here",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/cms/tokens/sites\"",
        response: { status: 401, body: { error: "Unauthorized" } },
      },
    ],
  },
];

// ─── Automation (intake/freshness — PAT-authenticated, publish-refused) ────

const AUTOMATION_ENDPOINTS: DocEndpoint[] = [
  {
    method: "POST",
    path: "/api/automation/faq",
    routeFile: "src/app/api/automation/faq/route.ts",
    group: "Automation",
    summary: "Draft a FAQ entry from the intake pipeline",
    description:
      "For the intake/freshness automation, not the CMS UI. Always creates the FAQ as `status: \"draft\"` regardless of any `status` sent — publishing is structurally a human action in the CMS UI, not a permission this token could be granted.",
    auth: "pat-or-session",
    permission: "content:create",
    body: {
      type: "object",
      properties: {
        question: { type: "string" },
        answer: { type: "string", description: "Defaults to the literal string \"TODO\" when omitted." },
        category: { type: "string", enum: [...FAQ_CATEGORIES] },
        audience: { type: "string", enum: [...FAQ_AUDIENCES], default: "sales-only" },
        slug: { type: "string" },
        sources: { type: "array", items: { type: "string" } },
        related: { type: "array", items: { type: "string" } },
        verify_every_days: { type: "integer", default: 365 },
      },
      required: ["question", "category"],
    },
    responses: [
      { status: 201, description: "The created draft FAQ." },
      { status: 400, description: "Missing question, or an invalid category/audience." },
      { status: 409, description: "Slug collision." },
    ],
    examples: [
      {
        title: "Draft a FAQ from an intake question",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/automation/faq\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"question\":\"How does the intake automation work?\",\"answer\":\"It drafts FAQs from support questions.\",\"category\":\"ci\"}'",
        response: {
          status: 201,
          body: { data: { id: "cmtyyh8ku000htrf6eufec5ps", slug: "how-does-the-intake-automation-work", status: "draft" } },
        },
      },
    ],
  },
  {
    method: "PATCH",
    path: "/api/automation/faq/{id}",
    routeFile: "src/app/api/automation/faq/[id]/route.ts",
    group: "Automation",
    summary: "Update a FAQ entry from the freshness pipeline",
    description:
      "Structurally refuses `status: \"published\"` with a 403 — unconditionally, not merely \"unless the token lacks content:publish\". `increment_asked_count: true` bumps the freshness counter.",
    auth: "pat-or-session",
    permission: "content:edit",
    pathParams: [{ name: "id", type: "string", required: true, description: "The FAQ's database id." }],
    body: {
      type: "object",
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        category: { type: "string", enum: [...FAQ_CATEGORIES] },
        audience: { type: "string", enum: [...FAQ_AUDIENCES] },
        status: { type: "string", enum: ["draft", "review"], description: "`published` is always refused (403) — see below." },
        last_verified: { type: ["string", "null"], format: "date-time" },
        verify_every_days: { type: "integer" },
        sources: { type: "array", items: { type: "string" } },
        related: { type: "array", items: { type: "string" } },
        increment_asked_count: { type: "boolean" },
      },
    },
    responses: [
      { status: 200, description: "The updated FAQ." },
      { status: 400, description: "`status` was neither `draft` nor `review`, or an invalid category/audience." },
      { status: 403, description: "`status: \"published\"` was requested — always refused on this endpoint." },
      RESPONSE_404,
    ],
    examples: [
      {
        title: "Move a FAQ to review and bump its ask count",
        curl:
          "curl -X PATCH \"https://cms.interactor.com/api/automation/faq/cmtyyh8ku000htrf6eufec5ps\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"status\":\"review\",\"increment_asked_count\":true}'",
        response: { status: 200, body: { data: { id: "cmtyyh8ku000htrf6eufec5ps", status: "review", asked_count: 1 } } },
      },
      {
        title: "Attempting to publish is refused",
        curl:
          "curl -X PATCH \"https://cms.interactor.com/api/automation/faq/cmtyyh8ku000htrf6eufec5ps\" -H \"Authorization: Bearer cms_pat_...\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"status\":\"published\"}'",
        response: { status: 403, body: { error: "This endpoint cannot publish a FAQ — publishing is a human action in the CMS UI." } },
      },
    ],
  },
];

// ─── Identity ───────────────────────────────────────────────────────────────

const IDENTITY_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/api/cms/workspaces",
    routeFile: "src/app/api/cms/workspaces/route.ts",
    group: "Identity",
    summary: "List the workspaces a connection can reach",
    description:
      "A workspace is `<account email>/<organization slug>/<site slug>` (the site part optional). A connection made with \"All my organizations\" on the connector's consent page is not bound to one organization: it reaches every organization its accounts belong to (the owner's, plus any added with \"Add another account\"), and each request says where it acts with an `X-CMS-Workspace` header (MCP tools: the `workspace` argument). Without one, such a request is refused with the list, unless the connection reaches exactly one organization. The site part narrows the request like a token site scope. A one-organization token accepts a workspace naming its own organization (to narrow to a site) and refuses any other. Backs the `list_workspaces` MCP tool. With a browser session, lists the signed-in account's organizations.",
    auth: "pat-or-session",
    responses: [{ status: 200, description: "`all_organizations`, the connection's `accounts`, and `workspaces`." }, RESPONSE_401],
    examples: [
      {
        title: "List a two-account connection's workspaces (site entries shown)",
        curl: "curl https://cms.interactor.com/api/cms/workspaces -H \"Authorization: Bearer cms_pat_...\"",
        response: {
          status: 200,
          body: {
            "data": {
              "all_organizations": true,
              "accounts": [
                "dev@example.com",
                "second@example.com"
              ],
              "workspaces": [
                {
                  "workspace": "dev@example.com/dev-example-com-s-organization/website",
                  "account": "dev@example.com",
                  "organization": {
                    "id": "cmuehl37h0002qi8os5sfcyte",
                    "slug": "dev-example-com-s-organization",
                    "name": "dev@example.com's Organization"
                  },
                  "role": "owner",
                  "site": {
                    "slug": "website",
                    "name": "Website",
                    "url": null
                  }
                },
                {
                  "workspace": "second@example.com/second-example-com-s-organization/website",
                  "account": "second@example.com",
                  "organization": {
                    "id": "cmuf311nh00017gf6uockl20t",
                    "slug": "second-example-com-s-organization",
                    "name": "second@example.com's Organization"
                  },
                  "role": "owner",
                  "site": {
                    "slug": "website",
                    "name": "Website",
                    "url": null
                  }
                }
              ]
            }
          },
        },
      },
    ],
  },
  {
    method: "GET",
    path: "/api/me",
    routeFile: "src/app/api/me/route.ts",
    group: "Identity",
    summary: "Who am I, and what may I do",
    description:
      "The one endpoint that answers what the caller is allowed to do — call this first with a new token, and again after any refusal, before assuming a permission is missing. A token carries no scopes of its own: `permissions` is always the owner's live membership role in the org the token is bound to.",
    auth: "pat-or-session",
    responses: [{ status: 200, description: "Actor, organization, membership role, flattened permissions, and (for a token) its identity." }, RESPONSE_401],
    examples: [
      {
        title: "whoami, via a personal access token",
        curl: "curl -H \"Authorization: Bearer cms_pat_...\" \"https://cms.interactor.com/api/me\"",
        response: {
          status: 200,
          body: {
            data: {
              user: { id: "cmtyxp8h50002yof6qpeapon9", email: "apidocs-admin@example.com", name: "API Docs Admin" },
              organization: { id: "cmtyxp8ei0000yof6wc0ugurh", name: "API Docs Fixture Org", slug: "api-docs-fixture-org" },
              membership_role: "super_admin",
              permissions: ["content:create", "content:edit", "content:publish", "content:view"],
              auth_method: "token",
              token: { id: "cmtyxp8n2000eyof6atc041kn", name: "API docs fixture token", token_prefix: "cms_pat_ZH3h", site_scopes: [] },
            },
          },
        },
      },
      {
        title: "A lower-privilege token sees fewer permissions",
        curl: "curl -H \"Authorization: Bearer cms_pat_...(guest author)\" \"https://cms.interactor.com/api/me\"",
        response: {
          status: 200,
          body: {
            data: {
              user: { id: "cmtyxp8i70004yof6kgfe53h9", email: "apidocs-guest@example.com", name: "API Docs Guest Author" },
              membership_role: "guest_author",
              permissions: ["admin:access", "content:create", "content:view", "media:view"],
              auth_method: "token",
            },
          },
        },
      },
    ],
  },
];

// ─── MCP ────────────────────────────────────────────────────────────────────

const MCP_ENDPOINTS: DocEndpoint[] = [
  {
    method: "POST",
    path: "/api/mcp",
    routeFile: "src/app/api/mcp/route.ts",
    group: "MCP",
    summary: "Remote MCP server (Streamable HTTP, stateless)",
    description:
      "For LLM clients (Claude Code, Claude Desktop, any MCP client) to manage CMS content — every tool delegates in-process to the matching `/api/cms` route with the same bearer, so RBAC/tenancy/sanitization are the REST API's own. Authenticates with a personal access token ONLY — unlike the `pat-or-session` endpoints elsewhere in this document, a browser session cookie is never accepted here, since an MCP client has no session to send. A missing/invalid token gets a 401 with a `WWW-Authenticate: Bearer` challenge before any JSON-RPC handling, so MCP clients' own auth discovery works.",
    auth: "pat-or-session",
    body: {
      type: "object",
      description: "A JSON-RPC 2.0 request per the MCP Streamable HTTP transport (e.g. `initialize`, `tools/list`, `tools/call`).",
    },
    responses: [
      { status: 200, description: "A `text/event-stream` (or plain JSON) JSON-RPC response." },
      {
        status: 401,
        description: "Missing, malformed, unknown, revoked, or expired token.",
        example: { error: "Unauthorized: pass a personal access token as 'Authorization: Bearer cms_pat_...'" },
      },
    ],
    examples: [
      {
        title: "No credential",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/mcp\" -H \"Content-Type: application/json\" \\\n" +
          "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'",
        response: { status: 401, body: { error: "Unauthorized: pass a personal access token as 'Authorization: Bearer cms_pat_...'" } },
      },
      {
        title: "initialize handshake",
        curl:
          "curl -X POST \"https://cms.interactor.com/api/mcp\" -H \"Authorization: Bearer cms_pat_...\" \\\n" +
          "  -H \"Content-Type: application/json\" -H \"Accept: application/json, text/event-stream\" \\\n" +
          "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"docs-example\",\"version\":\"1.0.0\"}}}'",
        response: {
          status: 200,
          body:
            "event: message\ndata: {\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"interactor-cms\",\"version\":\"1.0.0\"},\"instructions\":\"Content management for the Interactor CMS...\"},\"jsonrpc\":\"2.0\",\"id\":1}",
        },
      },
    ],
  },
];

// ─── Combined surface + the deliberately-undocumented allowlist ────────────

export const ENDPOINTS: DocEndpoint[] = [
  ...PUBLIC_ENDPOINTS,
  ...FORM_ENDPOINTS,
  ...POSTS_ENDPOINTS,
  ...CATEGORIES_ENDPOINTS,
  ...TAGS_ENDPOINTS,
  ...MEDIA_ENDPOINTS,
  ...FAQS_ENDPOINTS,
  ...CONTENT_TYPES_ENDPOINTS,
  ...SITES_ENDPOINTS,
  ...COMMENTS_ENDPOINTS,
  ...TOKENS_ENDPOINTS,
  ...AUTOMATION_ENDPOINTS,
  ...IDENTITY_ENDPOINTS,
  ...MCP_ENDPOINTS,
];

/**
 * Routes deliberately excluded from the documented surface, with why. The
 * drift test (spec.test.ts) requires every (path, method) pair discovered
 * under `src/app/api` to be covered by either `ENDPOINTS` or here — nothing
 * may go unaccounted for.
 *
 * `pathPrefix` matches routes whose derived URL path starts with it (e.g.
 * `/api/social/` covers every method on every route under it). `path` matches
 * a route's derived URL path exactly — use it (with `method`) when only some
 * methods at a path are undocumented, as with the contacts/newsletter/
 * waitlist forms, whose POST is documented above but whose GET is not.
 * Exactly one of `path`/`pathPrefix` must be set; `method` narrows either to
 * one HTTP method, and is omitted to cover every method at the match.
 */
export type UndocumentedEntry = { reason: string; method?: DocEndpoint["method"] } & (
  | { path: string; pathPrefix?: never }
  | { path?: never; pathPrefix: string }
);

export const UNDOCUMENTED: UndocumentedEntry[] = [
  { pathPrefix: "/api/me/profile", reason: "Session-only plumbing for the CMS UI's Settings → Profile page (the signed-in person's byline name and bio), not an integration surface." },
  { pathPrefix: "/api/auth/", reason: "NextAuth's own internal sign-in/callback/session machinery, not an integration surface." },
  { pathPrefix: "/api/register", reason: "Self-serve signup for the CMS UI itself, not a content API." },
  { pathPrefix: "/api/password", reason: "Local password reset flow for the CMS UI, not a content API." },
  { pathPrefix: "/api/organizations", reason: "Session-only org lifecycle management for the CMS UI (create/switch/settings), not a content API." },
  { pathPrefix: "/api/users", reason: "Session-only user/role administration for the CMS UI." },
  { pathPrefix: "/api/roles", reason: "Session-only role list for the CMS UI's admin screens." },
  { pathPrefix: "/api/invitations", reason: "Session-only invitation management for the CMS UI." },
  { pathPrefix: "/api/social/", reason: "Social publishing (Buffer/Hootsuite-style scheduling) is a separate, still-evolving feature area — not covered by this goal's scope." },
  { pathPrefix: "/api/ai/", reason: "AI content-generation/style-profile endpoints back specific editor UI, not a general integration surface." },
  { pathPrefix: "/api/build-feedback/", reason: "Server-side proxy to the Interactor Build feedback widget, scoped to the signed-in CMS session." },
  { pathPrefix: "/api/content-sync/", reason: "GitHub OAuth connect flow for the file-based content-sync feature; session-only CMS UI plumbing." },
  { pathPrefix: "/api/oauth/", reason: "OAuth 2.1 protocol endpoints for the MCP connector (register/token/revoke, plus the consent form's submit). Clients discover them from /.well-known/oauth-authorization-server (RFC 8414), not from this spec." },
  { pathPrefix: "/api/edit/", reason: "Private protocol between the CMS and the Interactor CMS plugin's sync tool, authenticated only by a one-post edit key from open_for_editing — not a general integration surface." },
  { pathPrefix: "/api/webhooks/", reason: "Inbound webhooks verified by provider signature (Interactor Core, GitHub), not caller-initiated integration endpoints." },
  { path: "/api/contacts", method: "GET", reason: "Session-only admin review of submissions; only the public POST is documented above." },
  { pathPrefix: "/api/contacts/", reason: "Session-only admin review of one submission (view/delete); only the public POST /api/contacts is documented above." },
  { path: "/api/newsletter", method: "GET", reason: "Session-only admin review of submissions; only the public POST is documented above." },
  { pathPrefix: "/api/newsletter/", reason: "Session-only admin review of one submission; only the public POST /api/newsletter is documented above." },
  { path: "/api/waitlist", method: "GET", reason: "Session-only admin review of submissions; only the public POST is documented above." },
  { pathPrefix: "/api/waitlist/", reason: "Session-only admin review of one submission; only the public POST /api/waitlist is documented above." },
];
