-- The ring-fenced clock becomes the board's to set (decision 32 of the issue
-- module plan, ADR 0057). The free text of an issue of a ring-fenced type is
-- removed this many whole years after closing: from one to ten, apart from the
-- clock of the ordinary types. Every instance starts at one, the year the
-- purge kept before this setting, so an upgrade moves no pending date.
ALTER TABLE "association"
  ADD COLUMN "ringFencedIssueTextRetentionYears" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "association_ring_fenced_issue_text_retention_years_range"
    CHECK ("ringFencedIssueTextRetentionYears" BETWEEN 1 AND 10);
