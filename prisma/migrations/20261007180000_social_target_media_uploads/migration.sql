-- Uploads a social target has already made to its network (X media ids,
-- LinkedIn image URNs, Facebook unpublished photos, Instagram carousel item
-- containers), so a retried publish reuses them instead of uploading again.
-- NULL on every existing row: nothing uploaded yet.
ALTER TABLE "social_post_targets" ADD COLUMN     "media_uploads" JSONB;
