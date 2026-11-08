-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "platforms" TEXT[] DEFAULT ARRAY['website']::TEXT[];
