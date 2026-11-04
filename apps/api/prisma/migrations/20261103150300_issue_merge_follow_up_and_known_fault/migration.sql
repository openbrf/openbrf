-- Merging duplicates, following up a closed issue, and the known fault
-- (decisions 8 and 22 of the issue module plan, ADR 0054).
--
-- Every column is null on every existing row: no issue has been merged,
-- followed up or given a notice before this.

-- The issue a duplicate was merged into. SetNull, because the duplicate keeps
-- its outcome whatever becomes of the issue it was merged into.
ALTER TABLE "issue" ADD COLUMN "mergedIntoIssueId" TEXT;

-- The earlier issue a new one follows up. A plain reference without a foreign
-- key (ADR 0054): it survives the earlier issue being purged.
ALTER TABLE "issue" ADD COLUMN "followsIssueId" TEXT;

-- The notice itself, the role it is signed with and when it was published.
ALTER TABLE "issue" ADD COLUMN "knownFault" TEXT,
  ADD COLUMN "knownFaultSignature" "IssueSignature",
  ADD COLUMN "knownFaultPublishedAt" TIMESTAMP(3);

ALTER TABLE "issue"
  ADD CONSTRAINT "issue_mergedIntoIssueId_fkey" FOREIGN KEY ("mergedIntoIssueId") REFERENCES "issue"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Merging is the only writer of a duplicate's link, and it closes the issue
  -- as a duplicate: an issue linked to another while open, or closed with
  -- another outcome, would tell its reporter to follow an issue nobody merged
  -- it into.
  ADD CONSTRAINT "issue_merged_only_as_duplicate" CHECK (
    "mergedIntoIssueId" IS NULL OR "outcome" = 'DUPLICATE'
  ),
  ADD CONSTRAINT "issue_not_merged_into_itself" CHECK (
    "mergedIntoIssueId" IS NULL OR "mergedIntoIssueId" <> "id"
  ),
  ADD CONSTRAINT "issue_not_following_itself" CHECK (
    "followsIssueId" IS NULL OR "followsIssueId" <> "id"
  ),
  -- A notice comes with its signature and its date, never without them, and
  -- never only whitespace.
  ADD CONSTRAINT "issue_known_fault_whole" CHECK (
    ("knownFault" IS NULL) = ("knownFaultSignature" IS NULL)
    AND ("knownFault" IS NULL) = ("knownFaultPublishedAt" IS NULL)
  ),
  ADD CONSTRAINT "issue_known_fault_present" CHECK (
    "knownFault" IS NULL OR btrim("knownFault") <> ''
  ),
  -- Closing clears it: a fault that is no longer known stops being shown.
  ADD CONSTRAINT "issue_known_fault_only_open" CHECK (
    "knownFault" IS NULL OR "closedAt" IS NULL
  );

CREATE INDEX "issue_mergedIntoIssueId_idx" ON "issue"("mergedIntoIssueId");

CREATE INDEX "issue_followsIssueId_idx" ON "issue"("followsIssueId");
