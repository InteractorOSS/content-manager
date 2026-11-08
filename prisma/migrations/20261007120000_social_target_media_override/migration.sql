-- Per-channel media for a social post (punchlist S1): replaces the post's
-- `media` for this one target. NULL means "use the post's media", which is
-- what every existing target keeps doing.
ALTER TABLE "social_post_targets" ADD COLUMN     "media_override" JSONB;
