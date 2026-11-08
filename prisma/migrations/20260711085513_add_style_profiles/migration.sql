-- CreateTable
CREATE TABLE "style_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'user',
    "owner_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_samples" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "liked_notes" TEXT,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_guide_versions" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "guide" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_guide_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "profile_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT,
    "formats" TEXT[],
    "mode" TEXT NOT NULL DEFAULT 'create',
    "status" TEXT NOT NULL DEFAULT 'running',
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "outputs" JSONB,
    "error" TEXT,
    "inserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "style_guide_versions_profile_id_version_key" ON "style_guide_versions"("profile_id", "version");

-- AddForeignKey
ALTER TABLE "style_samples" ADD CONSTRAINT "style_samples_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "style_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_guide_versions" ADD CONSTRAINT "style_guide_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "style_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

