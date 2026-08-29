-- CreateTable
CREATE TABLE "contact_submission" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "emailCipher" TEXT NOT NULL,
    "emailIndex" TEXT,
    "message" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "handledAt" TIMESTAMP(3),
    "handledByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_submission_handled_createdAt_idx" ON "contact_submission"("handled", "createdAt");

-- CreateIndex
CREATE INDEX "contact_submission_emailIndex_idx" ON "contact_submission"("emailIndex");
