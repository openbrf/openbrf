-- One send of a report to the cooperative housing register per duty at a time
-- (ADR 0029), held by a row instead of a transaction-scoped advisory lock.
--
-- The lock lived on a pooled connection for as long as the send waited for
-- Lantmateriet, and the disclosure entries the send commits on their own
-- before the hand-over needed a second connection while it did. With
-- OPENBRF_DATABASE_POOL_SIZE=1 there is no second, so a send waited for itself
-- until the transaction expired; with the default pool, enough concurrent
-- sends did the same to each other. A row is taken, read and let go by single
-- statements, so a send holds no connection while it waits.
--
-- Not part of the statutory archive: deleted when the send ends, and taken
-- over once expired, which is how a claim left by a process that died lets the
-- duty be sent again. It holds no personal data.
CREATE TABLE "register_transmission_claim" (
    "obligationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "register_transmission_claim_pkey" PRIMARY KEY ("obligationId")
);

ALTER TABLE "register_transmission_claim" ADD CONSTRAINT "register_transmission_claim_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "register_report_obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
