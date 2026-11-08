-- G#34 (SEO-AEO-GEO-PLAN.md Layer D): per-site IndexNow verification key.
-- Nullable — auto-generated on site creation going forward, and lazily
-- backfilled the first time the public indexnow-key endpoint is read for a
-- site that predates this column (see src/lib/indexnow.ts).
ALTER TABLE "sites" ADD COLUMN     "indexnow_key" TEXT;
