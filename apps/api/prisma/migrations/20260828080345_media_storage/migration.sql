/*
  Warnings:

  - You are about to drop the column `logoPath` on the `association` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MediaVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_UPLOADED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ACCESSED';

-- AlterTable
ALTER TABLE "association" DROP COLUMN "logoPath",
ADD COLUMN     "logoDarkFileId" TEXT,
ADD COLUMN     "logoFileId" TEXT;

-- CreateTable
CREATE TABLE "media_file" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "showsIdentifiablePersons" BOOLEAN,
    "visibility" "MediaVisibility" NOT NULL DEFAULT 'INTERNAL',
    "requiredCapability" TEXT,
    "uploadedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_file_storageKey_key" ON "media_file"("storageKey");

-- CreateIndex
CREATE INDEX "media_file_createdAt_idx" ON "media_file"("createdAt");

-- AddForeignKey
ALTER TABLE "association" ADD CONSTRAINT "association_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES "media_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "association" ADD CONSTRAINT "association_logoDarkFileId_fkey" FOREIGN KEY ("logoDarkFileId") REFERENCES "media_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;
