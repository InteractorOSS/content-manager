-- Per-org distribution targets (G#18), replacing the hardcoded allowlist in
-- src/lib/platforms.ts.
--
-- Schema only, deliberately no data: `Post.platforms` is a String[] of slugs
-- with no foreign key to this table, and the built-in "website" /
-- "product-manager" slugs are supplied virtually by BUILT_IN_SITES in
-- src/lib/sites.ts. Nothing reads a Site row to decide whether a post is
-- visible, so there is no backfill to do and no post's targeting changes.

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sites_organization_id_slug_key" ON "sites"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "sites_organization_id_name_key" ON "sites"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
