-- CreateEnum
CREATE TYPE "ImportSourceFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ImportSessionStatus" AS ENUM ('MAPPING', 'APPLIED');

-- CreateTable
CREATE TABLE "import_session" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "format" "ImportSourceFormat" NOT NULL,
    "columns" TEXT[],
    "rowsCipher" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "status" "ImportSessionStatus" NOT NULL DEFAULT 'MAPPING',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_session_status_expiresAt_idx" ON "import_session"("status", "expiresAt");
