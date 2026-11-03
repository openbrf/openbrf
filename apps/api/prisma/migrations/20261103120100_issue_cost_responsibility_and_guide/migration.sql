-- Who pays for an issue, the link from a member charge to the issue it was
-- made from, and the association's responsibility guide (decisions 26 and 27
-- of the issue module plan, ADR 0054).
--
-- Every existing issue says nothing about who pays: nobody decided it, so
-- nothing is derived. Every existing charge was made from no issue.
CREATE TYPE "IssueCostResponsibility" AS ENUM ('ASSOCIATION', 'TENANT_OWNER', 'UNCLEAR');

CREATE TYPE "MaintenanceResponsibility" AS ENUM ('ASSOCIATION', 'TENANT_OWNER');

ALTER TABLE "issue" ADD COLUMN "costResponsibility" "IssueCostResponsibility";

-- A plain column and no foreign key, so removing the charge leaves the issue
-- and an issue taken away leaves the charge: see the schema.
ALTER TABLE "member_charge" ADD COLUMN "issueId" TEXT;

CREATE INDEX "member_charge_issueId_idx" ON "member_charge"("issueId");

-- One row at most, written the first time the board saves the guide. No row
-- is the guide nobody has adopted, which is what every instance has today.
CREATE TABLE "responsibility_guide" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "adoptedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "responsibility_guide_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "responsibility_guide_singleton" CHECK ("id" = 1)
);

CREATE TABLE "responsibility_guide_item" (
    "id" TEXT NOT NULL,
    "part" TEXT NOT NULL,
    "responsibility" "MaintenanceResponsibility" NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_guide_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "responsibility_guide_item_sortOrder_idx" ON "responsibility_guide_item"("sortOrder");
