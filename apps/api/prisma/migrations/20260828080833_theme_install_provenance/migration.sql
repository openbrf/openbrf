-- A theme install records where the package came from and what its manifest
-- declared, so inheritance can be recomputed when an ancestor changes without
-- re-reading the package from the data volume.
--
-- The three NOT NULL columns take no default. installed_theme is empty on every
-- instance: the table was created ahead of the install path, and until this
-- migration there was no code that could write a row to it.

-- AlterTable
ALTER TABLE "installed_theme" ADD COLUMN     "catalogId" TEXT,
ADD COLUMN     "declaredDarkTokens" JSONB NOT NULL,
ADD COLUMN     "declaredLightTokens" JSONB NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "sourceUrl" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "installed_theme_extendsThemeId_idx" ON "installed_theme"("extendsThemeId");
