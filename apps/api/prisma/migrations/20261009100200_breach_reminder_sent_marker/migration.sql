-- Who the breach reminder has reached, and for which discovery.
--
-- The reminder is the only warning the board gets before the 72 hours of
-- art. 33(1) run out. It was sent to everyone each time its job ran, so a
-- discovery time corrected from A to B and back to A queued two jobs that both
-- fired, and a send that reached some of the board and failed for the rest was
-- retried for all of them. The job now records here, under the breach's lock,
-- the board members it reached and the discovery instant they were reached for.

ALTER TABLE "personal_data_breach" ADD COLUMN "reminderFor" TIMESTAMP(3);
ALTER TABLE "personal_data_breach" ADD COLUMN "reminderSentTo" TEXT[] DEFAULT ARRAY[]::TEXT[];
