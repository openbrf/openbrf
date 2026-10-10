-- The guard functions name what they read, and look nowhere else for it.
--
-- A trigger function runs as whoever writes the table, and it resolves every
-- name it does not qualify through that writer's search_path. A session's own
-- temporary schema comes first on that path unless the path places it
-- elsewhere, so a runtime role able to create temporary tables could create
-- one called "transfer", fill it with whatever the guard should find, and
-- write a transfer_reversal or a register_report_obligation row that the real
-- transfer would refuse. Both tables are append-only: a row let in that way
-- could never be taken out again.
--
-- So every openbrf_ function is fixed to pg_catalog first and the temporary
-- schema last, the path PostgreSQL recommends for a function whose caller is
-- not trusted, and the two that read other tables name each table and type
-- with its schema. Either change alone would close this; both are made because
-- the next function written here should find the pattern already in place.
-- The hardening script also takes TEMPORARY away from the runtime role, so the
-- shadowing table cannot be created in the first place.
--
-- CREATE OR REPLACE keeps a function's OID, so every trigger that calls one is
-- untouched. The three functions that read no table keep their bodies and
-- take the setting through ALTER FUNCTION; the two shared guard functions in
-- particular are not restated, which scripts/check-statutory-guards.mjs
-- reserves to the migrations that defined them.

ALTER FUNCTION public.openbrf_forbid_mutation()
  SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.openbrf_forbid_truncate()
  SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.openbrf_check_transfer_record()
  SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.openbrf_keep_oauth_client_disabled()
  SET search_path = pg_catalog, pg_temp;

-- 20260912252000's body, with the transfer and its kind named in public.
CREATE OR REPLACE FUNCTION public.openbrf_check_transfer_reversal()
RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  transfer_apartment TEXT;
  transfer_kind public."TransferKind";
BEGIN
  SELECT t."apartmentId", t."kind"
    INTO transfer_apartment, transfer_kind
    FROM public."transfer" t
   WHERE t."id" = NEW."transferId";

  -- A reference to no row at all is the foreign key's to refuse, and it names
  -- the constraint that was broken. A BEFORE ROW trigger runs before the key is
  -- checked, so without this the row would be refused here instead.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF transfer_apartment IS DISTINCT FROM NEW."apartmentId" THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_REVERSAL: the reversal names apartment % but the overlatelse it undoes is about %',
      NEW."apartmentId", transfer_apartment
      USING ERRCODE = 'raise_exception';
  END IF;

  -- An upplatelse is not an overlatelse. The right comes into being at a grant,
  -- so there is no earlier holder for it to go back to, and 3 kap. 3 § tredje
  -- stycket is about a registered overlatelse. A row written before "kind"
  -- existed carries none and is left alone, on the reading 20260912220000 takes
  -- of the same absence: what such a row was is not recorded, and refusing it
  -- here would be the platform deciding.
  IF transfer_kind = 'GRANT' THEN
    RAISE EXCEPTION
      'OPENBRF_TRANSFER_REVERSAL: transfer % is an upplatelse, and Lag (2026:484) 3 kap. 3 § tredje stycket is about an overlatelse that has been havd or gone back to the seller',
      NEW."transferId"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 20260912252000's body, with the three event tables and the transfer's two
-- types named in public.
CREATE OR REPLACE FUNCTION public.openbrf_check_report_obligation_event()
RETURNS TRIGGER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  event_apartment TEXT;
  event_date DATE;
  event_kind public."TransferKind";
  event_basis public."TransferReportBasis";
BEGIN
  IF NEW."transferId" IS NOT NULL THEN
    SELECT t."apartmentId", t."kind", t."reportBasis",
           CASE
             WHEN NEW."kind" = 'GRANT' THEN t."transferredOn"
             WHEN t."reportBasis" IN (
               'ALREADY_MEMBER',
               'OUTSIDE_MEMBERSHIP_REQUIREMENT',
               'TO_THE_ASSOCIATION'
             ) THEN t."transferredOn"
             ELSE t."membershipDecidedOn"
           END
      INTO event_apartment, event_kind, event_basis, event_date
      FROM public."transfer" t
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

    IF NEW."kind" = 'TRANSFER'
       AND event_basis = 'LIENHOLDING_JURIDICAL_PERSON' THEN
      RAISE EXCEPTION
        'OPENBRF_REPORT_OBLIGATION_EVENT: the overgang on transfer % is anmald by the juridical person that acquired it (Lag (2026:484) 3 kap. 3 § forsta stycket, BRL 6 kap. 1 § andra stycket), so the association has no reporting duty to record',
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
      FROM public."termination" e
     WHERE e."id" = NEW."terminationId";

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."reversalId" IS NOT NULL THEN
    SELECT r."apartmentId", r."reversedOn"
      INTO event_apartment, event_date
      FROM public."transfer_reversal" r
     WHERE r."id" = NEW."reversalId";

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    -- No reference: register_report_obligation_event_matches_kind is what
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
