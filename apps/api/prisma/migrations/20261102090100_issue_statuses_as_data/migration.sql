-- Issue types and statuses as data (ADR 0054).
--
-- Before this, an issue type carried one audience (NON_MEMBER, MEMBER, BOARD)
-- and an issue one of three statuses spelled by an enum. After it, a type
-- carries the set of groups who may report it, and its own statuses as rows,
-- each belonging to one of four fixed meanings. Everything that decides reads
-- the meaning; the label is the board's own text.
--
-- What it does to the rows an association already has:
--
--   * Each type's audience becomes a one-element set of reporters: NON_MEMBER
--     the website's form, MEMBER the residents, BOARD the handlers.
--   * Types with the same name, compared after trimming and as written
--     otherwise, merge into one whose reporters are the union of theirs - but
--     only those that agree on `active`. A type has one `active` where today
--     each audience's row has its own, so the active duplicates of a name merge
--     into one active type and the inactive ones into one inactive type: an
--     audience the board had closed stays closed. The type kept is the first of
--     its duplicates in the board's order, so the merged type keeps the
--     earliest place; the issues filed under the others move to it.
--   * Every type gets the default set of statuses, one of each meaning, named
--     in the association's language as the wizard set it.
--   * Every issue moves onto the default status of the meaning its old status
--     named: NEW onto New, IN_PROGRESS onto In progress, DONE onto Done. Its
--     closing date stays. It gets no outcome: nobody decided one for it, and
--     the platform does not invent one (ADR 0054).
--
-- The audience and status columns, and the IssueAudience type, are dropped once
-- their values are carried by the new columns and rows; nothing reads them
-- afterwards. The indexes are built inside the migration's transaction rather
-- than CONCURRENTLY, which a transaction cannot do: the issue tables hold one
-- association's reports, not a table that a short lock would hold up.
--
-- The audit log is not touched. An ISSUE_STATUS_CHANGED entry written before
-- this carries the old status names, which are the names of the meanings now,
-- so it still reads as what happened.

-- The old enum is the meaning. Renamed rather than replaced, so the issue's
-- status column can be read against the new statuses below.
ALTER TYPE "IssueStatus" RENAME TO "IssueStatusMeaning";

CREATE TYPE "IssueReporterGroup" AS ENUM ('PUBLIC', 'RESIDENTS', 'HANDLERS');

CREATE TYPE "IssueWaitingReason" AS ENUM ('REPORTER', 'CONTRACTOR', 'PARTS', 'DECISION');

CREATE TYPE "IssueOutcome" AS ENUM ('FIXED', 'TENANT_OWNER_RESPONSIBILITY', 'NO_FAULT', 'REFERRED', 'DUPLICATE');

-- Who may report a type, from its audience.
ALTER TABLE "issue_type" ADD COLUMN "reporters" "IssueReporterGroup"[];

UPDATE "issue_type"
SET "reporters" = ARRAY[
  CASE "audience"
    WHEN 'NON_MEMBER' THEN 'PUBLIC'
    WHEN 'MEMBER' THEN 'RESIDENTS'
    WHEN 'BOARD' THEN 'HANDLERS'
  END
]::"IssueReporterGroup"[];

-- A list column Prisma declares nullable; a type always says who may report
-- it, even if that is nobody.
ALTER TABLE "issue_type"
  ADD CONSTRAINT "issue_type_reporters_present" CHECK ("reporters" IS NOT NULL);

-- Which type each type merges into: the first of the duplicates of its name
-- and its `active` in the board's order, with the oldest and then the
-- identifier breaking a tie. A type with no duplicate maps onto itself.
CREATE TEMPORARY TABLE "issue_type_merge" AS
SELECT
  "id",
  first_value("id") OVER (
    PARTITION BY btrim("name"), "active"
    ORDER BY "sortOrder", "createdAt", "id"
  ) AS "keepId"
FROM "issue_type";

UPDATE "issue_type" AS "kept"
SET "reporters" = ARRAY(
  SELECT DISTINCT "reporter"
  FROM "issue_type" AS "duplicate"
  JOIN "issue_type_merge" AS "merge" ON "merge"."id" = "duplicate"."id"
  CROSS JOIN LATERAL unnest("duplicate"."reporters") AS "reporter"
  WHERE "merge"."keepId" = "kept"."id"
  ORDER BY "reporter"
)
WHERE "kept"."id" IN (
  SELECT "keepId" FROM "issue_type_merge" WHERE "id" <> "keepId"
);

UPDATE "issue"
SET "typeId" = "merge"."keepId"
FROM "issue_type_merge" AS "merge"
WHERE "issue"."typeId" = "merge"."id"
  AND "merge"."id" <> "merge"."keepId";

DELETE FROM "issue_type"
WHERE "id" IN (SELECT "id" FROM "issue_type_merge" WHERE "id" <> "keepId");

DROP TABLE "issue_type_merge";

DROP INDEX "issue_type_audience_active_sortOrder_idx";

ALTER TABLE "issue_type" DROP COLUMN "audience";

DROP TYPE "IssueAudience";

CREATE INDEX "issue_type_active_sortOrder_idx" ON "issue_type"("active", "sortOrder");

-- A type's statuses.
CREATE TABLE "issue_status" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "meaning" "IssueStatusMeaning" NOT NULL,
    "label" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_status_pkey" PRIMARY KEY ("id"),
    -- A label is the board's text, and an empty one names nothing.
    CONSTRAINT "issue_status_label_present" CHECK (btrim("label") <> ''),
    -- The default of a meaning is where an issue goes when no status is named,
    -- so it can never be one a handler could not move an issue into.
    CONSTRAINT "issue_status_default_active" CHECK (NOT "isDefault" OR "active")
);

CREATE INDEX "issue_status_typeId_meaning_sortOrder_idx" ON "issue_status"("typeId", "meaning", "sortOrder");

-- The target of the issue's composite key below.
CREATE UNIQUE INDEX "issue_status_id_typeId_key" ON "issue_status"("id", "typeId");

-- At most one default per type and meaning. Written by hand: Prisma has no
-- partial unique index. At least one is the service's to keep, since the
-- default is the one status it refuses to switch off.
CREATE UNIQUE INDEX "issue_status_one_default" ON "issue_status"("typeId", "meaning") WHERE "isDefault";

ALTER TABLE "issue_status" ADD CONSTRAINT "issue_status_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "issue_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The default set on every type, named in the association's language. The
-- labels are the ones the application writes on a type a board adds later
-- (`issues.status.*` in the translations). An instance whose wizard has not
-- run has no association row, and is Swedish until it says otherwise.
INSERT INTO "issue_status" ("id", "typeId", "meaning", "label", "isDefault", "active", "sortOrder", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  "type"."id",
  "defaults"."meaning"::"IssueStatusMeaning",
  CASE WHEN "locale"."value" = 'en' THEN "defaults"."en" ELSE "defaults"."sv" END,
  true,
  true,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "issue_type" AS "type"
CROSS JOIN (
  VALUES
    ('NEW', 'Ny', 'New'),
    ('IN_PROGRESS', 'Pågår', 'In progress'),
    ('WAITING', 'Väntar', 'Waiting'),
    ('DONE', 'Klar', 'Done')
) AS "defaults"("meaning", "sv", "en")
CROSS JOIN (
  SELECT COALESCE(
    (SELECT "defaultLocale" FROM "association" WHERE "id" = 1),
    'sv'
  ) AS "value"
) AS "locale";

-- Each issue onto its type's default status of the meaning it stood in.
ALTER TABLE "issue"
  ADD COLUMN "statusId" TEXT,
  ADD COLUMN "waitingReason" "IssueWaitingReason",
  ADD COLUMN "outcome" "IssueOutcome";

UPDATE "issue"
SET "statusId" = "status"."id"
FROM "issue_status" AS "status"
WHERE "status"."typeId" = "issue"."typeId"
  AND "status"."meaning" = "issue"."status"
  AND "status"."isDefault";

ALTER TABLE "issue" ALTER COLUMN "statusId" SET NOT NULL;

DROP INDEX "issue_status_createdAt_idx";

ALTER TABLE "issue" DROP COLUMN "status";

CREATE INDEX "issue_statusId_createdAt_idx" ON "issue"("statusId", "createdAt");

-- The status is one of the issue's own type's: the key names both.
ALTER TABLE "issue" ADD CONSTRAINT "issue_statusId_typeId_fkey" FOREIGN KEY ("statusId", "typeId") REFERENCES "issue_status"("id", "typeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An outcome belongs to a closed issue and a waiting reason to an open one.
-- The meaning lives on the status row, out of a check constraint's reach, so
-- the closing date stands in for it: it is written on the move into DONE and
-- cleared on the move out, in the same update as these two.
ALTER TABLE "issue"
  ADD CONSTRAINT "issue_outcome_only_closed" CHECK ("outcome" IS NULL OR "closedAt" IS NOT NULL),
  ADD CONSTRAINT "issue_waiting_reason_only_open" CHECK ("waitingReason" IS NULL OR "closedAt" IS NULL);
