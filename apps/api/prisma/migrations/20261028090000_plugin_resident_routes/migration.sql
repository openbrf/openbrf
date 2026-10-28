-- The paths of the resident routes the board consented to (ADR 0051). Empty on
-- every plugin installed before they were recorded: such an install consented
-- to none, so a version that declares one is refused at load until the board
-- consents again.
ALTER TABLE "installed_plugin" ADD COLUMN "consentedResidentRoutes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
