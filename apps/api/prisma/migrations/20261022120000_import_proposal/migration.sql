-- An import proposal: a member list a plugin hands the core for the board to
-- review (ADR 0043).
--
-- A proposal is an import session no person uploaded. "proposedByPluginId"
-- names the plugin, "senderCipher" holds who sent the file as the plugin
-- reports it, encrypted like the rows, "proposalOutcome" how it ended without
-- being applied, and "decidedAt" when it left the mapping step. A plugin has at
-- most one proposal waiting, which the partial unique index holds beside the
-- lock the core takes per plugin.
--
-- "rowsCipher" becomes nullable: every session, proposed or uploaded, drops its
-- rows once it has ended, and a decided proposal keeps its record, without
-- them, for 90 days.
--
-- "import_source"."pluginId" makes a plugin one source with one saved mapping.
-- No backfill: no session or source before this came from a plugin. The
-- indexes are built in the migration's transaction rather than CONCURRENTLY:
-- both tables hold a handful of rows, since sessions are purged within a day
-- and sources within two years of their last use.

-- CreateEnum
CREATE TYPE "ImportProposalOutcome" AS ENUM ('REJECTED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "import_session" ALTER COLUMN "rowsCipher" DROP NOT NULL,
ADD COLUMN     "decidedAt" TIMESTAMPTZ(6),
ADD COLUMN     "proposalOutcome" "ImportProposalOutcome",
ADD COLUMN     "proposedByPluginId" TEXT,
ADD COLUMN     "senderCipher" TEXT;

-- AlterTable
ALTER TABLE "import_source" ADD COLUMN     "pluginId" TEXT;

-- CreateIndex
CREATE INDEX "import_session_proposedByPluginId_status_idx" ON "import_session"("proposedByPluginId", "status");

-- CreateIndex
CREATE INDEX "import_source_pluginId_idx" ON "import_source"("pluginId");

-- At most one pending proposal per plugin. Not expressible in the Prisma
-- schema, so kept here.
CREATE UNIQUE INDEX "import_session_one_pending_proposal_per_plugin" ON "import_session"("proposedByPluginId")
WHERE "proposedByPluginId" IS NOT NULL AND "status" = 'MAPPING' AND "proposalOutcome" IS NULL;
