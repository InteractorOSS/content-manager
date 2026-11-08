import type { PrismaClient } from "@prisma/client";
import { authorDisplayName } from "./rbac";

/** Longest byline we accept — a name, not a paragraph. */
export const DISPLAY_NAME_MAX = 80;
export const BIO_MAX = 1000;
export const JOB_TITLE_MAX = 100;
export const AUTHOR_SLUG_MAX = 64;
export const SAME_AS_MAX_URLS = 10;
export const SAME_AS_URL_MAX = 300;
// Same shape as SITE_SLUG_MAX_LENGTH's pattern in src/lib/sites.ts — a public
// URL path segment, not (yet) a value shared between the two.
const AUTHOR_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ProfilePatch = {
  display_name?: unknown;
  bio?: unknown;
  author_slug?: unknown;
  job_title?: unknown;
  same_as?: unknown;
};

export type ProfileValidation =
  | {
      ok: true;
      display_name?: string | null;
      bio?: string | null;
      author_slug?: string | null;
      job_title?: string | null;
      same_as?: string[];
    }
  | { ok: false; error: string };

/** Validate a profile PATCH body. Blank clears a field (back to the fallback). */
export function validateProfilePatch(body: ProfilePatch): ProfileValidation {
  const out: {
    display_name?: string | null;
    bio?: string | null;
    author_slug?: string | null;
    job_title?: string | null;
    same_as?: string[];
  } = {};
  if (body.display_name !== undefined) {
    if (body.display_name !== null && typeof body.display_name !== "string") {
      return { ok: false, error: "display_name must be a string" };
    }
    const v = (body.display_name ?? "").trim();
    if (v.length > DISPLAY_NAME_MAX) {
      return { ok: false, error: `display_name must be at most ${DISPLAY_NAME_MAX} characters` };
    }
    out.display_name = v || null;
  }
  if (body.bio !== undefined) {
    if (body.bio !== null && typeof body.bio !== "string") {
      return { ok: false, error: "bio must be a string" };
    }
    const v = (body.bio ?? "").trim();
    if (v.length > BIO_MAX) return { ok: false, error: `bio must be at most ${BIO_MAX} characters` };
    out.bio = v || null;
  }
  // Entity fields for E-E-A-T / AI-answer-engine clarity (G#31): a public
  // /author/<slug> page, a job title, and canonical profile URLs tying this
  // byline to one real identity (Person JSON-LD `sameAs`).
  if (body.author_slug !== undefined) {
    if (body.author_slug !== null && typeof body.author_slug !== "string") {
      return { ok: false, error: "author_slug must be a string" };
    }
    const v = (body.author_slug ?? "").trim().toLowerCase();
    if (v && v.length > AUTHOR_SLUG_MAX) {
      return { ok: false, error: `author_slug must be at most ${AUTHOR_SLUG_MAX} characters` };
    }
    if (v && !AUTHOR_SLUG_RE.test(v)) {
      return { ok: false, error: "author_slug must be lowercase alphanumeric words separated by '-'" };
    }
    out.author_slug = v || null;
  }
  if (body.job_title !== undefined) {
    if (body.job_title !== null && typeof body.job_title !== "string") {
      return { ok: false, error: "job_title must be a string" };
    }
    const v = (body.job_title ?? "").trim();
    if (v.length > JOB_TITLE_MAX) {
      return { ok: false, error: `job_title must be at most ${JOB_TITLE_MAX} characters` };
    }
    out.job_title = v || null;
  }
  if (body.same_as !== undefined) {
    if (!Array.isArray(body.same_as) || !body.same_as.every((v) => typeof v === "string")) {
      return { ok: false, error: "same_as must be an array of strings" };
    }
    if (body.same_as.length > SAME_AS_MAX_URLS) {
      return { ok: false, error: `same_as must have at most ${SAME_AS_MAX_URLS} URLs` };
    }
    const urls: string[] = [];
    for (const raw of body.same_as as string[]) {
      const v = raw.trim();
      if (!v) continue;
      if (v.length > SAME_AS_URL_MAX) {
        return { ok: false, error: `same_as URLs must be at most ${SAME_AS_URL_MAX} characters` };
      }
      if (!/^https:\/\//.test(v)) {
        return { ok: false, error: "same_as URLs must start with https://" };
      }
      urls.push(v);
    }
    out.same_as = urls;
  }
  return { ok: true, ...out };
}

type ProfileUser = {
  id: string;
  email: string;
  name: string | null;
  display_name: string | null;
};

/**
 * Save a person's profile and carry a byline change onto their posts.
 *
 * `Post.author_name` is a stored string (it is also the editor's free-text
 * Author field), so renaming yourself would otherwise leave every existing post
 * showing the old name. Only posts whose byline still reads exactly the OLD
 * effective name are rewritten: a byline someone deliberately set to something
 * else ("Interactor Team", a guest's name) is an override and stays put.
 *
 * Deliberately global (raw client, every org): these are the person's own
 * posts wherever they wrote them, and the name is theirs, not an org's.
 */
export async function updateAuthorProfile(
  client: Pick<PrismaClient, "$transaction">,
  user: ProfileUser,
  patch: {
    display_name?: string | null;
    bio?: string | null;
    author_slug?: string | null;
    job_title?: string | null;
    same_as?: string[];
  }
): Promise<{
  display_name: string | null;
  bio: string | null;
  author_slug: string | null;
  job_title: string | null;
  same_as: string[];
  byline: string;
  posts_updated: number;
}> {
  const before = authorDisplayName(user);
  const nextDisplayName = patch.display_name !== undefined ? patch.display_name : user.display_name;
  const after = authorDisplayName({ ...user, display_name: nextDisplayName });

  return client.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        ...(patch.display_name !== undefined && { display_name: patch.display_name }),
        ...(patch.bio !== undefined && { bio: patch.bio }),
        ...(patch.author_slug !== undefined && { author_slug: patch.author_slug }),
        ...(patch.job_title !== undefined && { job_title: patch.job_title }),
        ...(patch.same_as !== undefined && { same_as: patch.same_as }),
      },
      select: { display_name: true, bio: true, author_slug: true, job_title: true, same_as: true },
    });
    let posts_updated = 0;
    if (before !== after) {
      const res = await tx.post.updateMany({
        where: { author_id: user.id, author_name: before },
        data: { author_name: after },
      });
      posts_updated = res.count;
    }
    return { ...updated, byline: after, posts_updated };
  });
}
