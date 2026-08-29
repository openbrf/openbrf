-- CreateEnum
CREATE TYPE "IssueAudience" AS ENUM ('NON_MEMBER', 'MEMBER', 'BOARD');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE');

-- AlterTable
--
-- On by default. A sign-up request asks for an account on an instance holding a
-- statutory register and therefore stays shut until a board opens it; an issue
-- report produces a maintenance ticket and nothing else, and the association's
-- website is expected to take one from a neighbour without an account.
ALTER TABLE "association" ADD COLUMN     "issueReportingPublic" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "issue_type" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audience" "IssueAudience" NOT NULL DEFAULT 'MEMBER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'NEW',
    "reporterPersonId" TEXT,
    "reporterNameCipher" TEXT,
    "reporterEmailCipher" TEXT,
    "reporterEmailIndex" TEXT,
    "apartmentId" TEXT,
    "location" TEXT,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_photo" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issue_type_audience_active_sortOrder_idx" ON "issue_type"("audience", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "issue_status_createdAt_idx" ON "issue"("status", "createdAt");

-- CreateIndex
CREATE INDEX "issue_reporterPersonId_idx" ON "issue"("reporterPersonId");

-- CreateIndex
CREATE INDEX "issue_reporterEmailIndex_idx" ON "issue"("reporterEmailIndex");

-- CreateIndex
CREATE INDEX "issue_photo_issueId_sortOrder_idx" ON "issue_photo"("issueId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "issue_photo_issueId_fileId_key" ON "issue_photo"("issueId", "fileId");

-- AddForeignKey
ALTER TABLE "issue" ADD CONSTRAINT "issue_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "issue_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue" ADD CONSTRAINT "issue_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_photo" ADD CONSTRAINT "issue_photo_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_photo" ADD CONSTRAINT "issue_photo_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
