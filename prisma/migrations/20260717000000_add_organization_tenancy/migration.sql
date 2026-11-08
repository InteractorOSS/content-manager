-- DropIndex
DROP INDEX "Category_name_key";

-- DropIndex
DROP INDEX "Category_slug_key";

-- DropIndex
DROP INDEX "Post_slug_key";

-- DropIndex
DROP INDEX "newsletter_subscriptions_email_key";

-- DropIndex
DROP INDEX "social_campaigns_name_key";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "contact_submissions" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "feedback_entries" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "generation_jobs" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "newsletter_subscriptions" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "social_campaigns" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "social_channels" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "social_posts" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "style_profiles" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "waitlist" ADD COLUMN     "organization_id" TEXT;

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "logo" TEXT,
    "branding" JSONB,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_publicId_key" ON "organizations"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organization_id_name_key" ON "Category"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organization_id_slug_key" ON "Category"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Post_organization_id_slug_key" ON "Post"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_email_key" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriptions_organization_id_email_key" ON "newsletter_subscriptions"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "social_campaigns_organization_id_name_key" ON "social_campaigns"("organization_id", "name");

-- CreateIndex
CREATE INDEX "social_posts_organization_id_status_scheduled_at_idx" ON "social_posts"("organization_id", "status", "scheduled_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsletter_subscriptions" ADD CONSTRAINT "newsletter_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_channels" ADD CONSTRAINT "social_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_campaigns" ADD CONSTRAINT "social_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Backfill (T2): create the single "Interactor" tenant and stamp every
-- existing org-scoped row into it, so this migration is a zero-behavior-change
-- retrofit. organization_id stays NULLABLE at the schema level (T4b enforces
-- NOT NULL later); the backfill below leaves no NULLs on existing data.
-- ---------------------------------------------------------------------------

-- The single existing tenant.
INSERT INTO "organizations" ("id", "name", "slug", "publicId", "inserted_at", "updated_at")
VALUES ('org_interactor', 'Interactor', 'interactor', 'pub_interactor', NOW(), NOW());

-- Stamp every existing org-scoped row into the Interactor org.
UPDATE "Post"                     SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "Category"                 SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "Media"                    SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "invitations"              SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "contact_submissions"      SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "newsletter_subscriptions" SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "waitlist"                 SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "social_channels"          SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "social_campaigns"         SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "social_posts"             SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "style_profiles"           SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "generation_jobs"          SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;
UPDATE "feedback_entries"         SET "organization_id" = 'org_interactor' WHERE "organization_id" IS NULL;

-- Give every existing user a membership in the Interactor org. Role is derived
-- from their most-privileged current UserRole (lowest priority number wins):
-- super_admin -> owner (billing/org-deletion), every other role name maps 1:1.
-- The global UserRole rows are intentionally kept (T3), so the global
-- super_admin flag still lives there. Users with no role fall back to the
-- least-privileged guest_author.
INSERT INTO "memberships" ("id", "user_id", "organization_id", "role", "inserted_at", "updated_at")
SELECT
  'mbr_' || u."id",
  u."id",
  'org_interactor',
  COALESCE(
    (
      SELECT CASE WHEN r."name" = 'super_admin' THEN 'owner' ELSE r."name" END
      FROM "user_roles" ur
      JOIN "roles" r ON r."id" = ur."role_id"
      WHERE ur."user_id" = u."id"
      ORDER BY r."priority" ASC
      LIMIT 1
    ),
    'guest_author'
  ),
  NOW(),
  NOW()
FROM "users" u;
