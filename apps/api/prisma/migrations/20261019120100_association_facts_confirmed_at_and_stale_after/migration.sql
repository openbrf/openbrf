-- When a board member last stated that the association's facts hold, and how
-- many months they count as current after that.
--
-- The broker information page prints the date, so a broker can tell how
-- current the answers are. A save sets it and so does a confirmation that
-- changes nothing; updatedAt moves only on a save, which is why this is a
-- column of its own.
--
-- A row that exists was written by a save, and until now a save was the only
-- way the board could say the facts held. So the existing row is taken as
-- confirmed when it was last saved, rather than today: a migration that
-- stamped the deploy date on every instance would tell brokers that boards had
-- looked at their facts when none had.
--
-- Nullable all the same. From here on the board can set the months before it
-- has saved a single fact, which creates the row with no answer in it, and a
-- row with no answer has no date to print.

ALTER TABLE "association_facts" ADD COLUMN "confirmedAt" TIMESTAMP(3);

UPDATE "association_facts" SET "confirmedAt" = "updatedAt";

-- The board's own setting, three months unless it says otherwise. The bounds
-- are the service's, held here too so a seed or an import cannot store a
-- threshold the board's screen would refuse.
ALTER TABLE "association_facts"
    ADD COLUMN "staleAfterMonths" INTEGER NOT NULL DEFAULT 3,
    ADD CONSTRAINT "association_facts_stale_after_months_range"
        CHECK ("staleAfterMonths" BETWEEN 1 AND 12);
