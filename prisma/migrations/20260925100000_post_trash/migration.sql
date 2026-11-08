-- The post trash: deleting a post keeps a restorable snapshot for a while.
-- See DeletedPost in schema.prisma and src/lib/post-trash.ts.

-- CreateTable
CREATE TABLE "deleted_posts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "platforms" TEXT[],
    "snapshot" JSONB NOT NULL,
    "deleted_by_id" TEXT,
    "deleted_by_name" TEXT,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deleted_posts_organization_id_deleted_at_idx" ON "deleted_posts"("organization_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "deleted_posts" ADD CONSTRAINT "deleted_posts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
