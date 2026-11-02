-- The classes of caller beside residents that the administrator consented to a
-- plugin's resident routes serving (ADR 0053): the approved set. Empty on every
-- plugin installed before they were recorded, which approved none, so the host
-- serves no class for it and a version that declares one is refused at load
-- until the administrator consents again.
ALTER TABLE "installed_plugin" ADD COLUMN "consentedNonResidentCallers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
