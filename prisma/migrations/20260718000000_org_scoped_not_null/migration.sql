-- ---------------------------------------------------------------------------
-- SMM-CONSOLIDATION-PUNCHLIST T4b: enforce the tenancy invariant at the DB.
--
-- The T2 migration (20260717000000_add_organization_tenancy) added a NULLABLE
-- organization_id to every org-scoped table and backfilled existing rows into
-- the single "Interactor" org. Now that every write path stamps organization_id
-- (authenticated handlers via the tenant-scoped client; the public form POSTs
-- pinned to the Interactor org), we can make the column NOT NULL so a row can
-- never again exist without a tenant.
--
-- For each table:
--   1. Defensive backfill — stamp any straggler NULLs into the Interactor org
--      BEFORE adding the constraint, so the migration cannot fail on stale data
--      (verifies the T2 backfill left nothing behind).
--   2. SET NOT NULL.
--   3. Swap the FK from ON DELETE SET NULL (which is incompatible with a NOT
--      NULL column) to ON DELETE CASCADE — deleting an org now deletes its
--      content, matching Membership's cascade.
-- ---------------------------------------------------------------------------

-- Post
UPDATE "Post" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "Post" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "Post" DROP CONSTRAINT "Post_organization_id_fkey";
ALTER TABLE "Post" ADD CONSTRAINT "Post_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Category
UPDATE "Category" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "Category" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "Category" DROP CONSTRAINT "Category_organization_id_fkey";
ALTER TABLE "Category" ADD CONSTRAINT "Category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Media
UPDATE "Media" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "Media" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "Media" DROP CONSTRAINT "Media_organization_id_fkey";
ALTER TABLE "Media" ADD CONSTRAINT "Media_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invitation
UPDATE "invitations" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "invitations" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_organization_id_fkey";
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ContactSubmission
UPDATE "contact_submissions" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "contact_submissions" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "contact_submissions" DROP CONSTRAINT "contact_submissions_organization_id_fkey";
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NewsletterSubscription
UPDATE "newsletter_subscriptions" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "newsletter_subscriptions" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "newsletter_subscriptions" DROP CONSTRAINT "newsletter_subscriptions_organization_id_fkey";
ALTER TABLE "newsletter_subscriptions" ADD CONSTRAINT "newsletter_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SocialChannel
UPDATE "social_channels" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "social_channels" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "social_channels" DROP CONSTRAINT "social_channels_organization_id_fkey";
ALTER TABLE "social_channels" ADD CONSTRAINT "social_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SocialCampaign
UPDATE "social_campaigns" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "social_campaigns" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "social_campaigns" DROP CONSTRAINT "social_campaigns_organization_id_fkey";
ALTER TABLE "social_campaigns" ADD CONSTRAINT "social_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SocialPost
UPDATE "social_posts" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "social_posts" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "social_posts" DROP CONSTRAINT "social_posts_organization_id_fkey";
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Waitlist
UPDATE "waitlist" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "waitlist" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "waitlist" DROP CONSTRAINT "waitlist_organization_id_fkey";
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- StyleProfile
UPDATE "style_profiles" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "style_profiles" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "style_profiles" DROP CONSTRAINT "style_profiles_organization_id_fkey";
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GenerationJob
UPDATE "generation_jobs" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "generation_jobs" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_organization_id_fkey";
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Feedback
UPDATE "feedback_entries" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
ALTER TABLE "feedback_entries" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "feedback_entries" DROP CONSTRAINT "feedback_entries_organization_id_fkey";
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
