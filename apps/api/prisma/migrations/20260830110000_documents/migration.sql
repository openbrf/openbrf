-- CreateEnum
CREATE TYPE "DocumentAudience" AS ENUM ('BOARD', 'MEMBER', 'PUBLIC');

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "audience" "DocumentAudience" NOT NULL DEFAULT 'MEMBER',
    "mediaFileId" TEXT NOT NULL,
    "uploadedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_mediaFileId_key" ON "document"("mediaFileId");

-- CreateIndex
CREATE INDEX "document_audience_category_idx" ON "document"("audience", "category");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
