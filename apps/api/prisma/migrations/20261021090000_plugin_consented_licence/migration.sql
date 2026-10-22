-- The licence the board consented to a plugin reading (ADR 0042): the
-- entitlement and the services it may present the association's licence to.
--
-- Null and empty for every plugin installed before the consent existed. A
-- plugin installed since the manifest could declare a licence, and before this
-- column, is refused at boot until the board installs it again and so consents
-- to the declaration: the database does not hold the manifests it would need to
-- fill the column in, and a consent read into it would be one nobody gave.
--
-- One statement, so both columns arrive together or not at all.
ALTER TABLE "installed_plugin"
    ADD COLUMN "consentedLicenceEntitlement" TEXT,
    ADD COLUMN "consentedLicenceAudiences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
