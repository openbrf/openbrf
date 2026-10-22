-- A theme a plugin installed through host.themes.install (ADR 0046) records
-- which plugin installed it: the third source beside a catalog entry and a
-- theme composed on the instance. A plugin may install over a theme it
-- installed itself and over no other, so the row has to say which one that is.
--
-- Not a foreign key to the plugin's row. Removing the plugin leaves its themes
-- installed, recorded as installed by a plugin no longer present, and the board
-- removes them on the theme screen if it wants to.
ALTER TABLE "installed_theme" ADD COLUMN "installedByPluginId" TEXT;

-- A row has at most one source. Both set would be a theme the catalog and a
-- plugin each claim, and the rules on who may install over it would disagree.
ALTER TABLE "installed_theme"
  ADD CONSTRAINT "installed_theme_has_one_source"
  CHECK ("catalogId" IS NULL OR "installedByPluginId" IS NULL);
