-- A handler may redact the text of a work order (ADR 0057). The text is
-- erased as the clock erases it, and the date marks it as a handler's act. The
-- row stays, with whom it went to and when.
ALTER TABLE "work_order"
  ADD COLUMN "redactedAt" TIMESTAMP(3),
  -- A redaction leaves nothing behind: the mark stands only over an erased
  -- text, so a write that put words back under it is refused here as well as
  -- by the service.
  ADD CONSTRAINT "work_order_redacted_empty"
    CHECK ("redactedAt" IS NULL OR "body" IS NULL);
