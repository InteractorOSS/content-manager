-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "content_types" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_types_organization_id_slug_key" ON "content_types"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "content_types_organization_id_name_key" ON "content_types"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "content_types" ADD CONSTRAINT "content_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

