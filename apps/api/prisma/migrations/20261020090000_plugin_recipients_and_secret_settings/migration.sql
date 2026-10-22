-- Where a plugin connects to outside the instance, and the secret fields of
-- its settings (ADR 0037).
--
-- The consented recipients are a snapshot the loader compares an installed
-- manifest against, as it compares the consented actions. NOT NULL with an
-- empty default for the reason that column is: every plugin installed before
-- recipients existed declared none, and an empty list says so.
ALTER TABLE "installed_plugin"
  ADD COLUMN "consentedRecipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- One row per secret field, so one value is replaced by one statement. The
-- value is CipherSweet ciphertext bound to the plugin id and the key; the
-- table holds no plain value and no blind index, because nothing searches by
-- a credential. Deleted with the installation.
CREATE TABLE "plugin_secret_setting" (
    "pluginId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueCipher" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_secret_setting_pkey" PRIMARY KEY ("pluginId","key")
);

ALTER TABLE "plugin_secret_setting" ADD CONSTRAINT "plugin_secret_setting_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "installed_plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
