-- The display mode for screens (ADR 0050).
--
-- A device token for the core's display route is the same kind of token as a
-- plugin's, in the same table, with no plugin. The check keeps the two kinds
-- apart: a row with no plugin is the display route's and nothing else's, so a
-- token can never be issued with no plugin for a route the core does not have.
--
-- In one transaction, so a failure leaves none of the four changes behind.
BEGIN;

ALTER TABLE "plugin_device_token" ALTER COLUMN "pluginId" DROP NOT NULL;

ALTER TABLE "plugin_device_token" ADD CONSTRAINT "plugin_device_token_core_route_check"
  CHECK ("pluginId" IS NOT NULL OR "routeId" = 'display');

-- The board's mark that a news item, or an event with all its occurrences,
-- may be shown on a screen in the building ("show on screens"). Off on every
-- row, those written before this change included, until the board sets it.
ALTER TABLE "news" ADD COLUMN "onScreens" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "event" ADD COLUMN "onScreens" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
