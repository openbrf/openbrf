-- The event calendar (evenemangskalender): what the association arranges, and
-- the dates it happens on.
--
-- Service tier throughout. Neither table gets an append-only trigger, a
-- TRUNCATE guard or a REVOKE in harden-runtime-role.sql, because neither holds
-- statutory register content: a series is the association's own account of what
-- it is arranging, and an occurrence is one date in it. Neither holds personal
-- data - authorPersonId is a person reference and not data held about that
-- person, exactly as news."authorPersonId" is - so both are outside every purge
-- scope. The sign-ups are the personal data in this module and they arrive with
-- their own table, its own retention window and its own report section.

-- CreateEnum
--
-- No DAILY. Nothing a housing cooperative arranges happens every day, and a
-- daily rule over the two-year horizon would write out seven hundred rows for a
-- mistake nobody meant to make.
CREATE TYPE "EventRecurrenceFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'ANNUAL');

-- CreateTable
--
-- The series and never one date in it. firstOn, startsAtMinute and
-- durationMinutes state it the way a notice in the stairwell does - a date, a
-- time of day and how long it runs - and every occurrence's instants are
-- derived from those three on the Europe/Stockholm wall clock. Minutes past
-- local midnight rather than an instant, for the reason
-- bookable_resource."opensAtMinute" is: ten in the morning is ten in the
-- morning on the two Sundays a year that are 23 and 25 hours long.
--
-- The four recurrence columns are nullable together: all four null is a single
-- event, which is the degenerate series rather than a second shape. A rule
-- states exactly one end - recurrenceCount or recurrenceUntil - and the write
-- service refuses anything else, because the occurrences are written out when
-- the series is saved and nothing extends them afterwards. The same service
-- refuses a rule reaching more than 731 days past its first occurrence, so this
-- table never holds more than 105 occurrences for one series.
CREATE TABLE "event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "location" TEXT,
    "visibility" "PageVisibility" NOT NULL DEFAULT 'MEMBER',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "signupOpen" BOOLEAN NOT NULL DEFAULT false,
    "capacity" INTEGER,
    "authorPersonId" TEXT NOT NULL,
    "firstOn" DATE NOT NULL,
    "startsAtMinute" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "recurrenceFrequency" "EventRecurrenceFrequency",
    "recurrenceInterval" INTEGER,
    "recurrenceCount" INTEGER,
    "recurrenceUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- One date in a series, materialised rather than computed. A sign-up points at
-- the date it is for, so the date has to be a row with an id - which is also
-- what lets one occurrence be called off without touching the rest.
--
-- Both columns are instants and neither is a date column. This pair is what
-- every calendar query compares against, and one comparison has to answer "has
-- this happened" for every series at once.
CREATE TABLE "event_occurrence" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_published_visibility_idx" ON "event"("published", "visibility");

-- CreateIndex
--
-- One occurrence per series and start instant. An edit that wrote a date twice
-- would give a resident two identical entries to sign up to.
CREATE UNIQUE INDEX "event_occurrence_eventId_startsAt_key" ON "event_occurrence"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "event_occurrence_startsAt_idx" ON "event_occurrence"("startsAt");

-- AddForeignKey
--
-- Cascade rather than Restrict: an occurrence says nothing except through the
-- series that names it, so a series the board removes takes its dates with it.
-- What stops a series being removed at all is the refusal in the write service
-- when somebody has signed up to one of its dates.
ALTER TABLE "event_occurrence" ADD CONSTRAINT "event_occurrence_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
