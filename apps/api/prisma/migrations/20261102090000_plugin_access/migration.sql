-- A plugin access (tilläggsåtkomst, ADR 0053): the board's grant to one person
-- who has never lived here to be served by one plugin's resident routes.
--
-- Held or not held, like a system role: a withdrawal deletes the row, and the
-- audit log keeps who held which access between when. The rows go with the
-- plugin when it is removed, and with the person's row.
CREATE TABLE "plugin_access" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_access_personId_pluginId_key" ON "plugin_access"("personId", "pluginId");

CREATE INDEX "plugin_access_pluginId_idx" ON "plugin_access"("pluginId");

ALTER TABLE "plugin_access" ADD CONSTRAINT "plugin_access_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plugin_access" ADD CONSTRAINT "plugin_access_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "installed_plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The grant, the withdrawal, and the end a recorded residency brings. None of
-- them is used in this migration, which PostgreSQL would refuse.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ACCESS_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ACCESS_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ACCESS_ENDED';
