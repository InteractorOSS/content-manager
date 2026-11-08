-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "last_synced_hash" TEXT,
ADD COLUMN     "sync_conflict" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "content_sync_connections" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL DEFAULT 'github',
    "credential_id" TEXT,
    "external_user_id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "connected_by_id" TEXT,
    "metadata" JSONB,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_sync_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_sync_connections_credential_id_key" ON "content_sync_connections"("credential_id");

-- AddForeignKey
ALTER TABLE "content_sync_connections" ADD CONSTRAINT "content_sync_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
