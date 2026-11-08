-- CreateTable
CREATE TABLE "faq_intake_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "matched_faq_id" TEXT,
    "confidence" DOUBLE PRECISION,
    "created_faq_id" TEXT,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faq_intake_logs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "faq_intake_logs" ADD CONSTRAINT "faq_intake_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
