-- The audit log's vocabulary for the work this release carries: the way in
-- (invitations and self-signup decisions), the public website, publication
-- consent, and the retention engine. Added in one place so the values exist
-- before anything writes them, and so no later change has to reshape the type.
--
-- ALTER TYPE ... ADD VALUE may not be followed by a use of the new value in the
-- same transaction, and a migration runs as one. Nothing below uses these
-- values: the table this migration creates carries its own enum, and the first
-- writer of an AuditAction value added here runs long after this has committed.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVITATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNUP_REQUEST_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SIGNUP_REQUEST_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'THEME_COMPOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONSENT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONSENT_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAGE_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAGE_VISIBILITY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NEWS_EMAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_PLACED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'LEGAL_HOLD_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SERVICE_DATA_PURGED';

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('PHOTO', 'NAME_ON_SITE', 'BOARD_ROSTER');

-- CreateTable
CREATE TABLE "publication_consent" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "recordedByPersonId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publication_consent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "publication_consent_personId_scope_grantedAt_idx" ON "publication_consent"("personId", "scope", "grantedAt");

-- AddForeignKey
ALTER TABLE "publication_consent" ADD CONSTRAINT "publication_consent_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
