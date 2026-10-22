-- A device token for a plugin's own routes (ADR 0031).
--
-- A credential the board issues to one device - a screen in the stairwell -
-- for one of a plugin's declared device routes. Stored as its digest and
-- never the token. The rows go with the plugin when it is removed.
CREATE TABLE "plugin_device_token" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "issuedByPersonId" TEXT NOT NULL,
    "revokedByPersonId" TEXT,

    CONSTRAINT "plugin_device_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_device_token_tokenHash_key" ON "plugin_device_token"("tokenHash");

CREATE INDEX "plugin_device_token_pluginId_revokedAt_idx" ON "plugin_device_token"("pluginId", "revokedAt");

ALTER TABLE "plugin_device_token" ADD CONSTRAINT "plugin_device_token_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "installed_plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The device routes the board consented to, each as "id:path". Empty on every
-- plugin installed before device routes existed, none of which declares one.
ALTER TABLE "installed_plugin" ADD COLUMN "consentedDeviceRoutes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_TOKEN_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_TOKEN_REVOKED';
