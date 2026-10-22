-- Every path the board consented to as one of a plugin's device routes
-- (ADR 0031).
--
-- A device given a token for a route goes on asking its path after a later
-- consent drops or moves the route, after the plugin is removed and after it is
-- installed again, and every answer it gets there has to carry the headers a
-- device on another origin needs to read it. The latest consent names only the
-- routes declared now, so the paths are kept here, outside the plugin's row,
-- and never forgotten. Names no person.
CREATE TABLE "plugin_device_route_path" (
    "pluginId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_device_route_path_pkey" PRIMARY KEY ("pluginId","path")
);

-- The consents recorded before this table, each "id:path" with an id that
-- holds no colon.
INSERT INTO "plugin_device_route_path" ("pluginId", "path", "routeId")
SELECT "id", substring("route" FROM position(':' IN "route") + 1), split_part("route", ':', 1)
FROM "installed_plugin", unnest("consentedDeviceRoutes") AS "route"
WHERE position(':' IN "route") > 1 AND position(':' IN "route") < length("route")
ON CONFLICT DO NOTHING;
