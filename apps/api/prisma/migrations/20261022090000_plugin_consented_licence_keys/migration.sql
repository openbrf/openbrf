-- Whose licence the board consented to a plugin reading (ADR 0042): the issuer
-- and the fingerprints of its keys, beside the entitlement and the audiences.
--
-- Null and empty on every row. A row that records a consented licence without
-- them reads as consent to no licence, so a licensed plugin installed before
-- this column is refused at boot as `licence-widened` until the board installs
-- it again. Nothing fills them in: the database does not hold the manifests,
-- and keys read from the installed package would be the package's word for
-- what the board consented to, which is what the boot gate checks.
--
-- One statement, so the three columns arrive together or not at all.
ALTER TABLE "installed_plugin"
    ADD COLUMN "consentedLicenceIssuerName" TEXT,
    ADD COLUMN "consentedLicenceIssuerUrl" TEXT,
    ADD COLUMN "consentedLicenceKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
