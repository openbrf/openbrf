-- What a plugin offers other plugins, and what it extends (ADR 0030), as the
-- board consented to them.
--
-- Two snapshots the loader compares an installed manifest against, as it does
-- "consentedActions": a republished host plugin whose extension point comes to
-- accept more personal data, or an addon that comes to extend another point or
-- hand over more, is refused at boot as "extensions-widened" rather than
-- loaded, so a plugin cannot widen its reach by shipping an update.
--
-- Both default to empty, so every plugin already installed comes back offering
-- and extending nothing, which is what it declared.
ALTER TABLE "installed_plugin"
  ADD COLUMN "consentedExtensionPoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "installed_plugin"
  ADD COLUMN "consentedExtends" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
