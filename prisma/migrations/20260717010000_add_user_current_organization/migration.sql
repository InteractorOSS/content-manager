-- Org switcher target (SMM-CONSOLIDATION-PUNCHLIST T3): the user's currently
-- active membership. Nullable; loadActor falls back to the sole/first
-- membership when unset. No FK — an org deletion re-resolves the fallback.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "current_organization_id" TEXT;
