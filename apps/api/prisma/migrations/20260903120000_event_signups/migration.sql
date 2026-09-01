-- Sign-ups to the event calendar (anmalan): one person, one date.
--
-- Service tier, and the only personal data the calendar holds. The series
-- created by 20260903100000_events records who entered it the way
-- news."authorPersonId" does, which is a person reference rather than data held
-- about that person; this row says that a named person intends to be somewhere.
-- So it carries a retention window of its own - anchored on the end of the
-- occurrence it names, purged by its own job - and its own section in the data
-- subject access report.
--
-- No append-only trigger, no TRUNCATE guard and no REVOKE in
-- harden-runtime-role.sql: none of those belong to service-tier data, and the
-- application role has to be able to delete these rows for the purge to run at
-- all.
--
-- The audit actions for signing up and standing down are added by
-- 20260903130000_event_signup_audit_actions. None of them is used here.

-- CreateTable
--
-- Per occurrence and never per series, which is why event_occurrence is a table
-- at all: somebody signs up for the cleaning day on the 18th of April, and the
-- places are counted against that date. A row per series would have meant a
-- board offering twenty places at each of a year's cleaning days had offered
-- twenty for the year.
--
-- "personId" is a plain column and not a foreign key, for the reason
-- issue."reporterPersonId" and booking."bookedByPersonId" are: every referential
-- action either rewrites this row when a person is erased or vetoes the erasure
-- outright, and a purge must not have to negotiate with the event calendar.
--
-- "withdrawnAt" is a dated close and never a delete, on the precedent of a
-- called-off occurrence and a released legal hold: who was expected at a
-- cleaning day and who stood down are two different answers, and a deleted row
-- can only give the first by omission. It is also what makes a place given back
-- countable - the places taken are the rows with no withdrawal date - so
-- standing down frees a place the moment it is recorded.
--
-- "signedUpAt" is the sign-up that stands now and "createdAt" is the first time
-- this person put their name down for this date. Signing up again after standing
-- down clears the withdrawal date on the existing row rather than writing a
-- second one, because of the unique index below, so the two columns differ
-- exactly for the people who changed their mind twice.
CREATE TABLE "event_signup" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_signup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The places taken on one date: the count every claim is measured against, and
-- the roll-call whoever manages events reads.
CREATE INDEX "event_signup_occurrenceId_withdrawnAt_idx" ON "event_signup"("occurrenceId", "withdrawnAt");

-- CreateIndex
--
-- One person's sign-ups, which is what the access report section selects and
-- what the purge groups by.
CREATE INDEX "event_signup_personId_idx" ON "event_signup"("personId");

-- CreateIndex
--
-- One sign-up per person and date, ever. Expressible as a constraint, so it is
-- one: two rows would be one person counted twice against the places, and the
-- board's roll-call would name them twice.
CREATE UNIQUE INDEX "event_signup_occurrenceId_personId_key" ON "event_signup"("occurrenceId", "personId");

-- AddForeignKey
--
-- Cascade rather than Restrict: a sign-up says what it is only through the date
-- it names, which is the same argument event_occurrence makes about its series.
-- What stops a date somebody is standing on from going anywhere is the refusal
-- in the write service, and that refusal counts standing sign-ups only - a
-- withdrawal is a person saying they are not coming, and letting it veto the
-- board's edit for ever would turn a dated close into a lock on the calendar.
ALTER TABLE "event_signup" ADD CONSTRAINT "event_signup_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "event_occurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
