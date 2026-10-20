-- The day the board was last active, kept past the session it was read from
-- (ADR 0021).
--
-- The management API's summary gives the latest day on which somebody running
-- the association was active. It read that from the sessions and the audit
-- log, and a session is deleted on sign-out: a board member who visited today,
-- read and wrote nothing, and signed out left no trace of the day, and the host
-- would send a notice of thirty days' inactivity to a board that is using the
-- instance.
--
-- One row holding one day, written when a session is created or renewed for a
-- person who holds a board seat or ADMIN on that day. It names nobody: the day
-- is all the summary carries, and all this keeps.
--
-- No backfill. The sessions still open when this is applied are read as before,
-- and the row appears with the first sign-in or renewal after it.

-- CreateTable
CREATE TABLE "board_activity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastOn" DATE NOT NULL,

    CONSTRAINT "board_activity_pkey" PRIMARY KEY ("id")
);

-- One instance serves exactly one association, so the singleton row is pinned
-- rather than merely conventional.
ALTER TABLE "board_activity"
  ADD CONSTRAINT "board_activity_is_singleton" CHECK ("id" = 1);
