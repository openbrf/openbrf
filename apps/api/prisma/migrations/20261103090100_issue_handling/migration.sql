-- Issue handling (ADR 0054): who handles a type, its default priority and
-- default assignee, and on every issue an assignee, a priority, a target date,
-- whether it is closed to all but the board, and the handler who entered it.
--
-- Every existing type is handled by every handler and files at normal priority
-- with no default assignee, which is what every type was before this change.
-- Every existing issue is unassigned, at normal priority, with no target date,
-- open to every handler its type lets in, and filed by its reporter: nothing is
-- derived for a row nobody decided anything about.
--
-- The person columns are plain columns rather than foreign keys, for the reason
-- the schema gives over `reporterPersonId`.
CREATE TYPE "IssuePriority" AS ENUM ('URGENT', 'NORMAL', 'LOW');

CREATE TYPE "IssueHandledBy" AS ENUM ('EVERY_HANDLER', 'BOARD');

ALTER TABLE "issue_type"
  ADD COLUMN "handledBy" "IssueHandledBy" NOT NULL DEFAULT 'EVERY_HANDLER',
  ADD COLUMN "defaultPriority" "IssuePriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "defaultAssigneePersonId" TEXT;

CREATE INDEX "issue_type_defaultAssigneePersonId_idx" ON "issue_type"("defaultAssigneePersonId");

ALTER TABLE "issue"
  ADD COLUMN "enteredByPersonId" TEXT,
  ADD COLUMN "assigneePersonId" TEXT,
  ADD COLUMN "priority" "IssuePriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "targetDate" DATE,
  ADD COLUMN "boardOnly" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "issue_assigneePersonId_idx" ON "issue"("assigneePersonId");

CREATE INDEX "issue_enteredByPersonId_idx" ON "issue"("enteredByPersonId");

-- An issue's timeline is read from the audit log by the issue its entries
-- target, oldest first. An index rather than a scan of the whole log, which
-- grows with everything the association does.
--
-- Built in the migration's transaction rather than CONCURRENTLY, which a
-- transaction cannot do. The entrypoint applies migrations before the
-- application starts, so the lock the build holds blocks no writer, and one
-- association's log builds in moments.
CREATE INDEX "audit_log_entry_targetKind_targetId_createdAt_idx" ON "audit_log_entry"("targetKind", "targetId", "createdAt");
