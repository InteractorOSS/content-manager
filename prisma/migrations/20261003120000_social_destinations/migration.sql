-- One OAuth connection can post to several places (three Facebook Pages, five
-- Slack channels). Each place is its own social_channels row and the rows of
-- one connection share a credential, so credential_id can no longer be unique.
DROP INDEX "social_channels_credential_id_key";
CREATE INDEX "social_channels_credential_id_idx" ON "social_channels"("credential_id");
CREATE INDEX "social_channels_organization_id_external_user_id_idx" ON "social_channels"("organization_id", "external_user_id");

-- Whether a post's social copy goes to this destination unless the writer
-- says otherwise for that post. Every existing channel keeps receiving posts.
ALTER TABLE "social_channels" ADD COLUMN     "default_target" BOOLEAN NOT NULL DEFAULT true;

-- A post's own choice of destinations (array of social_channels ids); NULL
-- means "use the channels' defaults".
ALTER TABLE "Post" ADD COLUMN     "social_destinations" JSONB;
