-- A damage case (skadeärende, decision 28 of the issue module's plan), and the
-- rule that a ring-fenced issue type is handled by the board only (decision 32).

-- What caused an insurance damage, as a handler records it.
CREATE TYPE "IssueDamageCause" AS ENUM (
  'WATER',
  'FIRE',
  'BURGLARY',
  'VANDALISM',
  'WEATHER',
  'OTHER'
);

-- One mark per issue at most, removed with its issue. Nothing on it names a
-- person: the insurer is a firm, the claim number the insurer's own label.
CREATE TABLE "issue_damage_case" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "insurer" TEXT NOT NULL,
  "claimNumber" TEXT NOT NULL,
  "occurredOn" DATE NOT NULL,
  "cause" "IssueDamageCause" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "issue_damage_case_pkey" PRIMARY KEY ("id"),
  -- The service trims both and refuses a blank one; this keeps a write that
  -- went round it from storing a mark that says nothing.
  CONSTRAINT "issue_damage_case_insurer_present"
    CHECK (length(btrim("insurer")) > 0),
  CONSTRAINT "issue_damage_case_claim_number_present"
    CHECK (length(btrim("claimNumber")) > 0)
);

CREATE UNIQUE INDEX "issue_damage_case_issueId_key" ON "issue_damage_case"("issueId");

ALTER TABLE "issue_damage_case"
  ADD CONSTRAINT "issue_damage_case_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "issue"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A ring-fenced type is never handled by the property manager (decision 32).
-- The column has only existed on the module's own branch, which no release
-- carries, and there the board could ring-fence a type it had opened to every
-- handler. Such a type is handed to the board here, and whoever that shuts out
-- is unassigned from its issues and cleared as its default assignee: the
-- service does the same when the board ring-fences a type
-- (`IssueTypeService.setRingFence`), with an audit entry for each issue, which
-- a migration has no actor to write.
--
-- The board is an administrator, or a board member whose seat is held today,
-- the rule `issueHandlersWhere` spells in the service. Today is the server's
-- date here rather than the association's own, which can differ for the hours
-- around midnight; on a branch with no release that is not worth a second
-- spelling of the calendar.
UPDATE "issue_type"
  SET "handledBy" = 'BOARD'
  WHERE "ringFenced" AND "handledBy" <> 'BOARD';

-- Nor is one offered on the website's form, whose reporter is answered by mail
-- alone, and nothing about a ring-fenced issue is mailed.
UPDATE "issue_type"
  SET "reporters" = array_remove("reporters", 'PUBLIC'::"IssueReporterGroup")
  WHERE "ringFenced" AND 'PUBLIC'::"IssueReporterGroup" = ANY("reporters");

CREATE TEMPORARY TABLE "ring_fence_board" AS
  SELECT "personId" AS "id" FROM "system_role" WHERE "role" = 'ADMIN'
  UNION
  SELECT "personId" FROM "board_position"
    WHERE "electedOn" <= CURRENT_DATE
      AND ("endedOn" IS NULL OR "endedOn" > CURRENT_DATE);

UPDATE "issue"
  SET "assigneePersonId" = NULL
  FROM "issue_type"
  WHERE "issue"."typeId" = "issue_type"."id"
    AND "issue_type"."ringFenced"
    AND "issue"."assigneePersonId" IS NOT NULL
    AND "issue"."assigneePersonId" NOT IN (SELECT "id" FROM "ring_fence_board");

UPDATE "issue_type"
  SET "defaultAssigneePersonId" = NULL
  WHERE "ringFenced"
    AND "defaultAssigneePersonId" IS NOT NULL
    AND "defaultAssigneePersonId" NOT IN (SELECT "id" FROM "ring_fence_board");

DROP TABLE "ring_fence_board";

ALTER TABLE "issue_type"
  ADD CONSTRAINT "issue_type_ring_fenced_board_only"
    CHECK (NOT "ringFenced" OR "handledBy" = 'BOARD'),
  ADD CONSTRAINT "issue_type_ring_fenced_not_public"
    CHECK (NOT ("ringFenced" AND 'PUBLIC'::"IssueReporterGroup" = ANY("reporters")));
