-- When a board member last stated that the association's facts hold.
--
-- The broker information page prints it, so a broker can tell how current the
-- answers are. A save sets it and so does a confirmation that changes nothing;
-- updatedAt moves only on a save, which is why this is a column of its own.
--
-- A row that exists was written by a save, and until now a save was the only
-- way the board could say the facts held. So the existing row is taken as
-- confirmed when it was last saved, rather than today: a migration that
-- stamped the deploy date on every instance would tell brokers that boards had
-- looked at their facts when none had.

ALTER TABLE "association_facts" ADD COLUMN "confirmedAt" TIMESTAMP(3);

UPDATE "association_facts" SET "confirmedAt" = "updatedAt";

ALTER TABLE "association_facts"
    ALTER COLUMN "confirmedAt" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "confirmedAt" SET NOT NULL;
