-- Who the breach reminder has reached, per discovery instant.
--
-- The reminder is the only warning the board gets before the 72 hours of
-- art. 33(1) run out. It was sent to everyone each time its job ran, so a
-- discovery time corrected from A to B and back to A queued two jobs that both
-- fired, and a send that reached some of the board and failed for the rest was
-- retried for all of them. The job now records here, under the breach's lock,
-- the board members it reached, keyed by the discovery instant they were
-- reached for, so a correction back to A still finds A's receipts.

ALTER TABLE "personal_data_breach" ADD COLUMN "reminderReceipts" JSONB NOT NULL DEFAULT '{}';
