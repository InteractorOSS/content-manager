-- SEO data model (G#31, SEO-AEO-GEO-PLAN.md Layer A): per-field overrides on
-- Post, author-as-entity fields on User, and a slug-history table so an old
-- URL can answer with a redirect instead of a 404. Every new Post/User
-- column is nullable or has a safe default, so this is additive-only.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "answer_summary" TEXT,
ADD COLUMN     "canonical_url" TEXT,
ADD COLUMN     "content_updated_at" TIMESTAMP(3),
ADD COLUMN     "noindex" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "og_image" TEXT,
ADD COLUMN     "og_image_alt" TEXT,
ADD COLUMN     "redirect_to" TEXT,
ADD COLUMN     "seo_title" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "author_slug" TEXT,
ADD COLUMN     "job_title" TEXT,
ADD COLUMN     "same_as" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "post_slug_history" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "old_slug" TEXT NOT NULL,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "post_slug_history_post_id_idx" ON "post_slug_history"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_slug_history_organization_id_old_slug_key" ON "post_slug_history"("organization_id", "old_slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_author_slug_key" ON "users"("author_slug");

-- AddForeignKey
ALTER TABLE "post_slug_history" ADD CONSTRAINT "post_slug_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_slug_history" ADD CONSTRAINT "post_slug_history_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
