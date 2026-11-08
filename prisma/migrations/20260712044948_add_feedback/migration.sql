-- CreateTable
CREATE TABLE "feedback_entries" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'feedback',
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "author_name" TEXT,
    "author_email" TEXT,
    "submitted_by_id" TEXT,
    "page_url" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "ticket_number" INTEGER,
    "ticket_url" TEXT,
    "ticket_error" TEXT,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_entries_status_idx" ON "feedback_entries"("status");

-- CreateIndex
CREATE INDEX "feedback_entries_submitted_by_id_idx" ON "feedback_entries"("submitted_by_id");

-- AddForeignKey
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
