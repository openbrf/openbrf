-- CreateEnum
CREATE TYPE "InstalledPluginStatus" AS ENUM ('PENDING', 'INSTALLED', 'FAILED');

-- AlterTable
ALTER TABLE "installed_plugin" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "status" "InstalledPluginStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "tarballUrl" TEXT NOT NULL DEFAULT '';
