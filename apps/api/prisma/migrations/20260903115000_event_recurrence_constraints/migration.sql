-- The row-level rules of an event series, in the database rather than only in
-- the service that writes it.
--
-- The write service refuses every one of these, and that is not the point. The
-- argument is the one transfer_agreement_reference_present already makes on this
-- codebase: a constraint that is weaker than the service is not the boundary it
-- was added to be, because the service is not the only thing that can reach a
-- table. The seed, a migration, an import and a future module all write with the
-- same privileges, and the recurrence columns are four independent nullable
-- columns whose meaning comes entirely from agreeing with each other.
--
-- What a half-set rule would do if one arrived is concrete rather than
-- hypothetical. The API projects a series with `recurrenceFrequency` and
-- `recurrenceInterval` set as a rule and reads the two ends straight out of
-- their columns, so a row with a frequency and no end would be answered as a
-- rule whose end is absent - which the wire contract says cannot happen, since
-- exactly one of the two is always set - and a row with a frequency and no
-- interval would be answered as having no rule at all while the row says it has
-- one. Neither is reachable through the endpoint. Both are now unreachable
-- through the table.
--
-- What is NOT here, deliberately: the two-year horizon. Whether a rule reaches
-- past it depends on generating the dates the rule names, which is a program
-- rather than a predicate, so it stays where it is decided - in
-- checkRecurrenceSchedule. These constraints are the invariants of one row,
-- which is exactly the set a CHECK can state truthfully.
--
-- Fully valid rather than NOT VALID: both tables are created by
-- 20260903100000_events, so there are no rows anywhere that these could not
-- speak for.
--
-- Prisma has no syntax for a CHECK constraint, so none of this is represented in
-- schema.prisma; the columns' doc comments point here.

-- The four recurrence columns are set together or not at all, and a rule that is
-- set states exactly one end. `(a IS NULL) <> (b IS NULL)` is exactly-one-of.
ALTER TABLE "event"
  ADD CONSTRAINT "event_recurrence_states_one_end"
  CHECK (
    (
      "recurrenceFrequency" IS NULL
      AND "recurrenceInterval" IS NULL
      AND "recurrenceCount" IS NULL
      AND "recurrenceUntil" IS NULL
    )
    OR (
      "recurrenceFrequency" IS NOT NULL
      AND "recurrenceInterval" IS NOT NULL
      AND (("recurrenceCount" IS NULL) <> ("recurrenceUntil" IS NULL))
    )
  );

-- Every whole number of weeks, months or years, and at least one of them. An
-- interval of zero would name the same date for ever.
ALTER TABLE "event"
  ADD CONSTRAINT "event_recurrence_interval_positive"
  CHECK ("recurrenceInterval" IS NULL OR "recurrenceInterval" >= 1);

-- A rule counted in occurrences repeats, so it names at least two. One is a
-- single event, which is the same row with no rule at all rather than a rule
-- that happens once.
ALTER TABLE "event"
  ADD CONSTRAINT "event_recurrence_count_repeats"
  CHECK ("recurrenceCount" IS NULL OR "recurrenceCount" >= 2);

-- A last date is not before the first one.
--
-- The service refuses more than this: a rule whose until date falls before its
-- SECOND occurrence names one date and repeats nothing, so it is refused too.
-- That one is not here, and for the reason the horizon is not - deciding it
-- means stepping the rule forward once, which needs the month-end clamp and so
-- is arithmetic rather than a predicate. What is here is the half that is a
-- plain comparison of two columns of one row, which is what a CHECK can state
-- truthfully: an until date before firstOn describes a series with no dates at
-- all.
ALTER TABLE "event"
  ADD CONSTRAINT "event_recurrence_until_not_before_first"
  CHECK ("recurrenceUntil" IS NULL OR "recurrenceUntil" >= "firstOn");

-- Minutes past local midnight, so inside one day. 1440 would be midnight the
-- following morning, which is a different date than the one firstOn states.
ALTER TABLE "event"
  ADD CONSTRAINT "event_starts_at_minute_within_the_day"
  CHECK ("startsAtMinute" >= 0 AND "startsAtMinute" < 1440);

-- Wall-clock minutes, from one up to a whole day. An event may run past
-- midnight, which is why this is a duration and not a closing time, but nothing
-- the association arranges runs for longer than a day.
ALTER TABLE "event"
  ADD CONSTRAINT "event_duration_within_a_day"
  CHECK ("durationMinutes" >= 1 AND "durationMinutes" <= 1440);

-- Places at one occurrence. Null is no limit; zero would be sign-up offered and
-- impossible, which no screen could explain.
ALTER TABLE "event"
  ADD CONSTRAINT "event_capacity_positive"
  CHECK ("capacity" IS NULL OR "capacity" >= 1);

-- An occurrence ends after it starts. Both are instants derived from the series'
-- wall clock, and the duration behind them is at least one minute, so an
-- occurrence that closed before it opened could only come from a write that did
-- not go through that derivation.
ALTER TABLE "event_occurrence"
  ADD CONSTRAINT "event_occurrence_ends_after_it_starts"
  CHECK ("endsAt" > "startsAt");
