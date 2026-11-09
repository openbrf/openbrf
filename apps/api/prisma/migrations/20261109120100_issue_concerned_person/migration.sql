-- The people an issue concerns, as a handler records them (ADR 0057): personal
-- data of its own, removed with the issue's free-text layer.

CREATE TABLE "issue_concerned_person" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "issue_concerned_person_pkey" PRIMARY KEY ("id")
);

-- A person is recorded on an issue once.
CREATE UNIQUE INDEX "issue_concerned_person_issueId_personId_key"
  ON "issue_concerned_person"("issueId", "personId");

-- The cases a person is concerned in, which their access report reads.
CREATE INDEX "issue_concerned_person_personId_idx"
  ON "issue_concerned_person"("personId");

ALTER TABLE "issue_concerned_person"
  ADD CONSTRAINT "issue_concerned_person_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "issue"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Removed with the person, which only the first setup's rollback ever deletes.
ALTER TABLE "issue_concerned_person"
  ADD CONSTRAINT "issue_concerned_person_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "person"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
