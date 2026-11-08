-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "ai_generated_at" TIMESTAMP(3),
ADD COLUMN     "ai_generated_content" TEXT,
ADD COLUMN     "ai_style_profile_id" TEXT;

-- CreateTable
CREATE TABLE "guide_amendment_suggestions" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "post_id" TEXT,
    "diff_summary" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "suggested_guide" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "guide_amendment_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guide_amendment_suggestions_profile_id_status_idx" ON "guide_amendment_suggestions"("profile_id", "status");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_ai_style_profile_id_fkey" FOREIGN KEY ("ai_style_profile_id") REFERENCES "style_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_amendment_suggestions" ADD CONSTRAINT "guide_amendment_suggestions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "style_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_amendment_suggestions" ADD CONSTRAINT "guide_amendment_suggestions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
