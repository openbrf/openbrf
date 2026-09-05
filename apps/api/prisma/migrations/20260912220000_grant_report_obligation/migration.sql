-- The ledger's two checks learn the third duty.
--
-- 20260910100000 wrote both against a table with two kinds. A GRANT names a
-- transfer, like a TRANSFER does, but its window opens on a different day and
-- under a different paragraph, so neither check could be left as it was:
--
--   register_report_obligation_event_matches_kind refused any row whose kind was
--   not TRANSFER or TERMINATION, so a GRANT could not be written at all.
--
--   openbrf_check_report_obligation_event branched on which reference was
--   present. Both GRANT and TRANSFER carry a transferId, so it would have
--   checked a grant's window against transfer."membershipDecidedOn" - a date an
--   upplatelse has no reason to carry, and the row would have been refused on a
--   paragraph that has nothing to do with it.
--
-- The branch is on the kind now, which is what the statute keys on:
--
--   GRANT, Lag (2026:484) 3 kap. 2 §, counted from the upplatelse itself, which
--   is transfer."transferredOn".
--
--   TRANSFER, 3 kap. 3 § andra stycket, counted from the membership decision.
--
--   TERMINATION, 3 kap. 4 §, counted from the day the bostadsratt ceased.
--
-- And the transfer's own kind is checked against the obligation's, so an
-- overgang cannot be reported on the grant's clock by writing the wrong kind
-- here. A transfer written before "kind" existed carries none, and only a
-- TRANSFER obligation may name one: what such a row was is not recorded, so a
-- GRANT obligation on it would be the guess this platform refuses to make.

ALTER TABLE "register_report_obligation"
  DROP CONSTRAINT "register_report_obligation_event_matches_kind";

ALTER TABLE "register_report_obligation"
  ADD CONSTRAINT "register_report_obligation_event_matches_kind"
  CHECK (
    ("kind" IN ('GRANT', 'TRANSFER') AND "transferId" IS NOT NULL AND "terminationId" IS NULL)
    OR
    ("kind" = 'TERMINATION' AND "terminationId" IS NOT NULL AND "transferId" IS NULL)
  );

CREATE OR REPLACE FUNCTION openbrf_check_report_obligation_event()
RETURNS TRIGGER AS $$
DECLARE
  event_apartment TEXT;
  event_date DATE;
  event_kind "TransferKind";
BEGIN
  IF NEW."transferId" IS NOT NULL THEN
    SELECT t."apartmentId", t."kind",
           CASE WHEN NEW."kind" = 'GRANT' THEN t."transferredOn"
                ELSE t."membershipDecidedOn" END
      INTO event_apartment, event_kind, event_date
      FROM "transfer" t
     WHERE t."id" = NEW."transferId";

    -- A reference to no row at all is the foreign key's to refuse, and it names
    -- the constraint that was broken. A BEFORE ROW trigger runs before the key
    -- is checked, so without this the row would be refused here instead, on a
    -- message about a register event that does not exist.
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF NEW."kind" = 'GRANT' AND event_kind IS DISTINCT FROM 'GRANT' THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % is not recorded as an upplatelse, so Lag (2026:484) 3 kap. 2 § is not the paragraph its report is made under',
        NEW."transferId"
        USING ERRCODE = 'raise_exception';
    END IF;

    IF NEW."kind" = 'TRANSFER' AND event_kind = 'GRANT' THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % is an upplatelse, which is reported under Lag (2026:484) 3 kap. 2 § and not 3 kap. 3 §',
        NEW."transferId"
        USING ERRCODE = 'raise_exception';
    END IF;

    IF event_date IS NULL THEN
      IF NEW."kind" = 'GRANT' THEN
        RAISE EXCEPTION
          'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % carries no date of upplatelse to count Lag (2026:484) 3 kap. 2 §''s two weeks from',
          NEW."transferId"
          USING ERRCODE = 'raise_exception';
      ELSE
        RAISE EXCEPTION
          'OPENBRF_REPORT_OBLIGATION_EVENT: transfer % carries no membership decision, so Lag (2026:484) 3 kap. 3 § andra stycket names no day to count its two weeks from',
          NEW."transferId"
          USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
  ELSIF NEW."terminationId" IS NOT NULL THEN
    SELECT e."apartmentId", e."tookEffectOn"
      INTO event_apartment, event_date
      FROM "termination" e
     WHERE e."id" = NEW."terminationId";

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    -- Neither reference: register_report_obligation_event_matches_kind is what
    -- refuses this, and it says so more precisely than this trigger could.
    RETURN NEW;
  END IF;

  IF event_apartment IS DISTINCT FROM NEW."apartmentId" THEN
    RAISE EXCEPTION
      'OPENBRF_REPORT_OBLIGATION_EVENT: the obligation names apartment % but its register event is about %',
      NEW."apartmentId", event_apartment
      USING ERRCODE = 'raise_exception';
  END IF;

  IF event_date IS DISTINCT FROM NEW."triggeredOn" THEN
    RAISE EXCEPTION
      'OPENBRF_REPORT_OBLIGATION_EVENT: the window is dated % but the statute counts it from %, the date on the register event',
      NEW."triggeredOn", event_date
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
