-- A broker's request that the board look at the facts on the broker
-- information page again, sent once those facts are older than the board's
-- own threshold (association_facts.staleAfterMonths).
--
-- The broker's name and address are stored encrypted, as every contact detail
-- a stranger types into a public form is. No phone number is asked for and no
-- client address is stored: docs/broker-package-data-protection.md, "Request
-- updates". The apartment reference is the broker's own text and is not a key
-- to the apartment register.
--
-- Nothing to backfill. The table starts empty and no operator step is needed.

-- CreateTable
CREATE TABLE "broker_update_request" (
    "id" TEXT NOT NULL,
    "nameCipher" TEXT,
    "emailCipher" TEXT NOT NULL,
    "emailIndex" TEXT,
    "brokerage" TEXT,
    "apartmentReference" TEXT,
    "note" TEXT,
    "answeredAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_update_request_pkey" PRIMARY KEY ("id")
);

-- The board's queue reads the open requests oldest first, and the purge reads
-- both clocks by their dates.
CREATE INDEX "broker_update_request_answeredAt_createdAt_idx" ON "broker_update_request"("answeredAt", "createdAt");
CREATE INDEX "broker_update_request_createdAt_idx" ON "broker_update_request"("createdAt");

-- Each limit counts one key's requests over a recent window.
CREATE INDEX "broker_update_request_apartmentReference_createdAt_idx" ON "broker_update_request"("apartmentReference", "createdAt");
CREATE INDEX "broker_update_request_emailIndex_createdAt_idx" ON "broker_update_request"("emailIndex", "createdAt");
