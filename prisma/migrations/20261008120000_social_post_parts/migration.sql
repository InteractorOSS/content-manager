-- A social post as ordered parts: the root `body`, then X thread replies and
-- a first comment (src/lib/social/parts.ts). NULL on every existing row: X
-- copy written with `---` separator lines is read through those lines.
ALTER TABLE "social_posts" ADD COLUMN "parts" JSONB;

-- The provider id of each part a target has published, so a retry resumes
-- after the last one rather than posting the root again.
ALTER TABLE "social_post_targets" ADD COLUMN "published_parts" JSONB;
