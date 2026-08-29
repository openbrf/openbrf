-- CreateTable
CREATE TABLE "legal_hold" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "placedByPersonId" TEXT,
    "releasedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_hold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_hold_personId_releasedAt_idx" ON "legal_hold"("personId", "releasedAt");

-- AddForeignKey
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
