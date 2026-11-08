-- G#27: manual delivery mode for social channels — a channel with no API
-- access at all (e.g. a personal Facebook profile), where a human posts the
-- copy themselves and marks it posted. Defaults every existing channel to
-- "automated" (today's only behavior).
ALTER TABLE "social_channels" ADD COLUMN     "delivery_mode" TEXT NOT NULL DEFAULT 'automated';
