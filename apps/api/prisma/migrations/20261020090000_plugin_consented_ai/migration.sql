-- Whether the board consented to a plugin as an AI package (ADR 0038). False
-- for every plugin installed before the declaration existed, which is what
-- each of them was consented to as.
ALTER TABLE "installed_plugin" ADD COLUMN "consentedAi" BOOLEAN NOT NULL DEFAULT false;
