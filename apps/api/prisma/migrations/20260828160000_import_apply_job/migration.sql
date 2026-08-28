-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ImportSessionStatus" ADD VALUE 'QUEUED';
ALTER TYPE "ImportSessionStatus" ADD VALUE 'APPLYING';
ALTER TYPE "ImportSessionStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "import_session" DROP COLUMN "appliedAt",
ADD COLUMN     "ambiguousRows" JSONB,
ADD COLUMN     "decisions" JSONB,
ADD COLUMN     "defaultMovedInOn" TEXT,
ADD COLUMN     "defaultRole" "ResidencyRole",
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "mapping" TEXT[],
ADD COLUMN     "memberRegisterEntriesCreated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "personsCreated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "personsUpdated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "previewedAt" TIMESTAMP(3),
ADD COLUMN     "residenciesCreated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rowsDone" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rowsWithProblems" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMP(3);
