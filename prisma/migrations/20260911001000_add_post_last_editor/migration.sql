-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "updated_by_name" TEXT,
ADD COLUMN     "updated_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
