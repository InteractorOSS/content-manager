-- Revision checkpoints: an optional label on a revision (explicit checkpoints,
-- exempt from age-based thinning), and when an edit session last saved (one
-- snapshot per writing session / after a pause, not one per save).

-- AlterTable
ALTER TABLE "post_revisions" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "post_edit_keys" ADD COLUMN     "last_write_at" TIMESTAMP(3);
