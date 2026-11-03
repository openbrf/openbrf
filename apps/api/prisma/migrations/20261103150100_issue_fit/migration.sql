-- Permission to enter, common-area places and inspection findings on an issue
-- (decisions 29 to 31 of the issue module plan).
--
-- Nothing existing is rewritten: every new column on "issue" is nullable and
-- stays null for the issues already there, so adding them takes no table
-- rewrite. The index and the two CHECK constraints below scan "issue" once, in
-- this migration's transaction and not CONCURRENTLY: the entrypoint applies
-- migrations before the app serves, so the lock blocks no writer, and an
-- association's issues are counted in hundreds, not millions.
CREATE TYPE "IssueEntryAnswer" AS ENUM ('YES', 'NO');

CREATE TYPE "IssueFindingKind" AS ENUM ('OVK', 'LIFT', 'FIRE');

-- The association's list of common-area places.
CREATE TABLE "issue_place" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_place_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_place_name_present" CHECK (btrim("name") <> '')
);

CREATE INDEX "issue_place_sortOrder_idx" ON "issue_place"("sortOrder");

-- One place of a name, however it is capitalised: two "Hiss" rows would split
-- the count of faults in the lift between them, which is what the list is for.
CREATE UNIQUE INDEX "issue_place_name_lower_key" ON "issue_place"(lower(btrim("name")));

ALTER TABLE "issue"
    ADD COLUMN "placeId" TEXT,
    ADD COLUMN "entryAnswer" "IssueEntryAnswer",
    ADD COLUMN "entryNote" TEXT,
    ADD COLUMN "entryPets" BOOLEAN,
    ADD COLUMN "entryMasterKey" BOOLEAN,
    ADD COLUMN "entryUntil" DATE;

CREATE INDEX "issue_placeId_idx" ON "issue"("placeId");

ALTER TABLE "issue" ADD CONSTRAINT "issue_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "issue_place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The shape of an entry permission: nothing until it is answered, nothing but
-- the answer for a no, and for a yes the two things a contractor at the door
-- needs to know, pets and the master key, always stated.
ALTER TABLE "issue" ADD CONSTRAINT "issue_entry_shape" CHECK (
    (
        "entryAnswer" IS NULL
        AND "entryNote" IS NULL
        AND "entryPets" IS NULL
        AND "entryMasterKey" IS NULL
        AND "entryUntil" IS NULL
    )
    OR (
        "entryAnswer" = 'NO'
        AND "entryNote" IS NULL
        AND "entryPets" IS NULL
        AND "entryMasterKey" IS NULL
        AND "entryUntil" IS NULL
    )
    OR (
        "entryAnswer" = 'YES'
        AND "entryPets" IS NOT NULL
        AND "entryMasterKey" IS NOT NULL
    )
);

-- Cleared when the issue closes (decision 29). The service clears it in the
-- transaction that sets "closedAt"; this is the database refusing a path that
-- forgets to, so a closed issue never keeps what a resident said about getting
-- into their home.
ALTER TABLE "issue" ADD CONSTRAINT "issue_entry_cleared_at_closing" CHECK (
    "closedAt" IS NULL OR "entryAnswer" IS NULL
);

-- The mark of an inspection finding, at most one to an issue.
CREATE TABLE "issue_finding" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "kind" "IssueFindingKind" NOT NULL,
    "inspectedOn" DATE NOT NULL,
    "protocolAttachmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_finding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "issue_finding_issueId_key" ON "issue_finding"("issueId");

CREATE UNIQUE INDEX "issue_finding_protocolAttachmentId_key" ON "issue_finding"("protocolAttachmentId");

CREATE INDEX "issue_finding_kind_inspectedOn_idx" ON "issue_finding"("kind", "inspectedOn");

ALTER TABLE "issue_finding" ADD CONSTRAINT "issue_finding_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issue_finding" ADD CONSTRAINT "issue_finding_protocolAttachmentId_fkey" FOREIGN KEY ("protocolAttachmentId") REFERENCES "issue_attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The places an instance starts with, for an instance whose setup is already
-- complete: a new one gets them when its setup wizard finishes, in that
-- language, as it gets its issue types. Written in the association's language,
-- Swedish unless it chose English, and the board's to reword or remove. None of
-- them is an apartment.
INSERT INTO "issue_place" ("id", "name", "sortOrder", "updatedAt")
SELECT 'seed-issue-place-' || p.key,
       CASE WHEN a."defaultLocale" = 'en' THEN p.en ELSE p.sv END,
       p.ord,
       CURRENT_TIMESTAMP
FROM "association" a
CROSS JOIN (VALUES
    (0, 'laundry-room', 'Tvättstuga', 'Laundry room'),
    (1, 'lift', 'Hiss', 'Lift'),
    (2, 'yard', 'Gård', 'Yard'),
    (3, 'stairwell', 'Trapphus', 'Stairwell'),
    (4, 'basement', 'Källare', 'Basement'),
    (5, 'attic', 'Vind', 'Attic'),
    (6, 'bicycle-room', 'Cykelrum', 'Bicycle room'),
    (7, 'garage', 'Garage', 'Garage'),
    (8, 'waste-room', 'Soprum', 'Waste room')
) AS p(ord, key, sv, en)
WHERE a."setupCompletedAt" IS NOT NULL;
