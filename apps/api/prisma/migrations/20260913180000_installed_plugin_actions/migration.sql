-- What a plugin proposed, and what an administrator switched on.
--
-- Two lists rather than one, because they answer different questions and a
-- single one would conflate a proposal with a decision.
--
-- "consentedActions" is the snapshot the loader compares an installed manifest
-- against, exactly as "consentedPermissions" beside it is: a republished
-- version that declares an action the board never saw is refused rather than
-- loaded, so a plugin cannot widen its own reach by shipping an update.
--
-- "armedActions" is the deliberate act that offers an action to connected apps
-- and to the AI package. Declaring is a proposal; arming is what exposes it, so
-- adding a channel can never expose an action by itself. It is read at the
-- moment of the call rather than cached, which is what makes disarming bite at
-- once, and it is cleared whenever the board consents to a republished version:
-- an action that keeps its id while changing the capability it needs is a
-- different action wearing the same name, and re-arming it is one toggle.
--
-- Both default to empty, so every plugin already installed comes back with
-- nothing declared and nothing armed - which is the correct reading of an
-- instance that has never been asked the question.
--
-- Stated as NOT NULL with a default rather than left nullable. Prisma reads a
-- SQL NULL scalar list back as an empty array, so either shape loads; what
-- differs is what can be ASKED. An arming write is conditional on the consent
-- snapshot it was decided against still being the one on the row, and a scalar
-- list filter does not match NULL against an empty array - so a nullable column
-- would make that condition answer "changed" for a row that had simply never
-- been written. The column says what the comment above says.
ALTER TABLE "installed_plugin"
  ADD COLUMN "consentedActions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "installed_plugin"
  ADD COLUMN "armedActions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
