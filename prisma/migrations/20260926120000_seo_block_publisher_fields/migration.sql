-- Resolved seo block publisher identity (G#33, SEO-AEO-GEO-PLAN.md Layer C):
-- the Organization/Site fields the JSON-LD graph's publisher node and
-- sameAs list are built from. Additive-only.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "same_as" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "publisher_name" TEXT;
