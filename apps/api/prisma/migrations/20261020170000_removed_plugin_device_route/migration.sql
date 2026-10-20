-- The device routes of plugins that were removed (ADR 0031).
--
-- Kept so that a removed plugin's device route still answers its 404 with the
-- headers a device on another origin needs to read it, after the plugin's row
-- and its package are gone. Names no person.
CREATE TABLE "removed_plugin_device_route" (
    "pluginId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "removed_plugin_device_route_pkey" PRIMARY KEY ("pluginId","routeId")
);
