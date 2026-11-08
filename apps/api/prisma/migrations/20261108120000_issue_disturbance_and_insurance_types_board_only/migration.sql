-- An existing issue type for disturbances or for insurance is handed to the
-- board (decisions 13 and 32 of the issue module's plan, ADR 0054, "The interim
-- answer to question 5").
--
-- Before the module, a type was a name the board typed, and nothing said what
-- it was for. The type a new instance is seeded with for disturbances between
-- neighbours is ring-fenced, and the one for insurance is handled by the board
-- alone, but an upgraded instance's own types came out of
-- `20261103090100_issue_handling` handled by every handler, the property manager
-- included. A type whose name is exactly the seeded Swedish name, or its usual
-- singular or plural, is handled by the board alone from here. Exact names only:
-- "Driftstörningar" and "Störningar i TV/bredband" are outages, and a prefix
-- would shut the property manager out of their own work.
--
-- Nothing is ring-fenced here. A ring-fence cannot be lifted once a type has
-- issues, it removes the free text of every issue closed more than a year
-- earlier on the next nightly purge, and nothing about a ring-fenced issue is
-- mailed, its reporter included. Whether to take those on is the board's: it
-- ring-fences the type in the settings. Board-only is the default decision 13
-- gives both kinds of type, and the board can open the type to every handler
-- again in the settings.
--
-- The name is compared trimmed of spaces, tabs and line breaks, in Unicode's
-- composed form (NFC) where the database is UTF-8, and with Å, Ä and Ö folded by
-- hand, then lowercased under the "C" collation: the result then does not depend
-- on the database's locale. `lower` folds letters outside ASCII only under a
-- locale that knows them, which a database created under the C locale does not,
-- and under a Turkish locale it turns `I` into the dotless `ı`, which is not the
-- `i` of "FÖRSÄKRINGSÄRENDE".
--
-- In one transaction, so a failure leaves none of it behind: the audit log is
-- append-only, and an entry for an unassignment that was rolled back would stay.
BEGIN;

CREATE TEMPORARY TABLE "board_only_type" AS
  SELECT "id" FROM "issue_type"
    WHERE "handledBy" <> 'BOARD'
      AND lower(translate(
        btrim(
          CASE WHEN current_setting('server_encoding') = 'UTF8'
            THEN normalize("name", NFC)
            ELSE "name"
          END,
          ' ' || chr(9) || chr(10) || chr(13)
        ),
        'ÅÄÖ',
        'åäö'
      ) COLLATE "C") IN (
        'störningar',
        'störning',
        'försäkringsärende',
        'försäkringsärenden',
        'försäkring'
      );

UPDATE "issue_type"
  SET "handledBy" = 'BOARD'
  WHERE "id" IN (SELECT "id" FROM "board_only_type");

-- Whoever that shuts out is unassigned from the type's issues and cleared as its
-- default assignee, as `IssueTypeService.update` does when the board keeps a
-- type to itself and `20261104140100_issue_damage_case_and_ring_fence` did for a
-- ring-fenced one. Each unassignment gets the entry the service writes for it
-- (`ISSUE_ASSIGNED`, the previous assignee in its context), so the issue's
-- timeline shows it. Nobody acted, so the entry has no actor and is on the
-- system channel. An issue an upgrade carries over has no assignee yet, so on
-- an upgrade from a release this finds nobody.
--
-- The board is an administrator, or a board member whose seat is held today on
-- the association's calendar (Stockholm's, ADR 0014), the rule
-- `issueHandlersWhere` spells in the service. The database's own date would be
-- the previous day for an upgrade run just after midnight in Stockholm.
CREATE TEMPORARY TABLE "board_only_board" AS
  SELECT "personId" AS "id" FROM "system_role" WHERE "role" = 'ADMIN'
  UNION
  SELECT "personId" FROM "board_position"
    WHERE "electedOn" <= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Stockholm')::date
      AND ("endedOn" IS NULL
        OR "endedOn" > (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Stockholm')::date);

INSERT INTO "audit_log_entry"
  ("id", "action", "channel", "targetKind", "targetId", "context", "createdAt")
SELECT
  gen_random_uuid()::text,
  'ISSUE_ASSIGNED',
  'SYSTEM',
  'issue',
  "id",
  jsonb_build_object('previousAssigneePersonId', "assigneePersonId"),
  CURRENT_TIMESTAMP
  FROM "issue"
  WHERE "typeId" IN (SELECT "id" FROM "board_only_type")
    AND "assigneePersonId" IS NOT NULL
    AND "assigneePersonId" NOT IN (SELECT "id" FROM "board_only_board");

UPDATE "issue"
  SET "assigneePersonId" = NULL
  WHERE "typeId" IN (SELECT "id" FROM "board_only_type")
    AND "assigneePersonId" IS NOT NULL
    AND "assigneePersonId" NOT IN (SELECT "id" FROM "board_only_board");

UPDATE "issue_type"
  SET "defaultAssigneePersonId" = NULL
  WHERE "id" IN (SELECT "id" FROM "board_only_type")
    AND "defaultAssigneePersonId" IS NOT NULL
    AND "defaultAssigneePersonId" NOT IN (SELECT "id" FROM "board_only_board");

DROP TABLE "board_only_board";
DROP TABLE "board_only_type";

COMMIT;
