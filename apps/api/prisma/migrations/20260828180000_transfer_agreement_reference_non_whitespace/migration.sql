-- Tightens transfer_agreement_reference_present so a reference made only of
-- whitespace no longer satisfies it.
--
-- The previous predicate was btrim(COALESCE(col, '')) <> ''. PostgreSQL's
-- one-argument btrim strips spaces and nothing else, so a value of a single tab,
-- newline, carriage return or non-breaking space passed the constraint. The
-- service refuses all of those, because JavaScript's String.prototype.trim
-- strips the whole Unicode whitespace set - which meant the table accepted what
-- the only code path writing it rejects. The constraint exists precisely because
-- that code path is not the only writer: the seed, a migration and the import
-- all reach this table, and a constraint that is weaker than the service is not
-- the boundary it was added to be.
--
-- The class below is String.prototype.trim's set written out: U+0009 to U+000D,
-- U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F,
-- U+3000 and U+FEFF. Enumerated rather than written as [[:space:]] because that
-- class is locale-dependent and, in this database, already excludes U+00A0,
-- U+1680, U+202F and U+FEFF - a statutory constraint may not mean different
-- things on different deployments. U+200B is deliberately absent: it is not
-- whitespace, String.prototype.trim keeps it, and so does this.
--
-- Still NOT VALID, for the reason the original constraint was: a transfer
-- written before that requirement has no reference to be found, and backfilling
-- a placeholder would put a statement into a statutory register that nobody
-- made. Every insert and every update from here on is bound by it.
ALTER TABLE "transfer"
  DROP CONSTRAINT "transfer_agreement_reference_present";

ALTER TABLE "transfer"
  ADD CONSTRAINT "transfer_agreement_reference_present"
  CHECK (
    COALESCE("agreementReference", '') ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]'
    OR COALESCE("agreementDocumentPath", '') ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]'
  ) NOT VALID;
