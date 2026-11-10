-- Find the assignments that took an issue from a person without a scan of the
-- audit log (ADR 0057).
--
-- A former assignee's access report lists the entry that took the issue from
-- them, and that entry names them only as `previousAssigneePersonId` in its
-- context, which no existing index reaches. The index is on that one key and
-- holds only the entries that carry it, which are the assignments of an issue
-- that had an assignee. The report reads it with the same expression, so
-- the planner can use it.
--
-- Prisma cannot declare an expression index, so it is not in schema.prisma and
-- `prisma migrate diff` leaves it alone.
--
-- Built in the migration's transaction rather than CONCURRENTLY, which a
-- transaction cannot do. A plain CREATE INDEX blocks writes to audit_log_entry
-- until the build finishes, so the application is stopped before an upgrade
-- (docs/deployment.md, "The upgrade, step by step"); a `pull` and `up -d` that
-- leaves the previous application running holds its audited writes for the
-- length of the build.
CREATE INDEX "audit_log_entry_previousAssignee_idx"
  ON "audit_log_entry" ((("context" ->> 'previousAssigneePersonId')))
  WHERE ("context" ->> 'previousAssigneePersonId') IS NOT NULL;
