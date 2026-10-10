-- The last day of a consented letting that ended before its period did.
--
-- Recorded by the board, and read as the letting's last day by the retention
-- clock and by a granted erasure, which keeps the consent to a letting that is
-- still running (ADR 0016). Without it a consent to a letting that stopped early
-- was kept to the end of the period applied for, and an erasure waited for it.
ALTER TABLE "sublet_application" ADD COLUMN "lettingEndedOn" DATE;

-- Only a consented letting has an end the association records, and the end lies
-- inside the period consented to: a letting that went on past it needed a new
-- consent. The API refuses both first and with a reason code, so a violation
-- here is reachable only by a hand-written statement.
ALTER TABLE "sublet_application" ADD CONSTRAINT "sublet_application_letting_end_check"
  CHECK (
    "lettingEndedOn" IS NULL
    OR (
      "status" = 'CONSENTED'
      AND "lettingEndedOn" >= "periodFrom"
      AND "lettingEndedOn" <= "periodTo"
    )
  );
