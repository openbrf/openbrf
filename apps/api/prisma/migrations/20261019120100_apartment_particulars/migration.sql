-- What the apartment register holds about the apartment itself.
--
-- Bostadsrattslagen 9 kap. 10 § forsta stycket:
--
--   "Lagenhetsforteckningen ska for varje lagenhet ange
--    1. lagenhetens beteckning, belagenhet, rumsantal och ovriga utrymmen,
--    2. dagen for Bolagsverkets registrering av den ekonomiska plan som ligger
--       till grund for upplatelsen,
--    3. bostadsrattshavarens namn, samt
--    4. insatsen for bostadsratten."
--
-- The register held the designation, the location, the holder and the insats.
-- The room count, the other spaces and the plan's registration date were
-- missing, and they are content of the register itself: 9 kap. 11 § makes the
-- holder's extract cover every field 10 § lists. Lag (2026:486) keeps all four
-- points and rewrites the first as "rumsantal och eventuell mark och andra
-- utrymmen som upplatelsen avser", which "otherSpaces" is worded to hold as
-- well.
--
-- The living area is added beside them. 10 § does not list it, but
-- Fastighetsmaklarlagen (2021:516) 3 kap. 15 § 3 has a broker describe the
-- apartment's size, and Forordning (2026:898) 2 kap. 3 § forsta stycket 4 lists
-- it with the room count.
--
-- All four are nullable and existing rows keep a null, which the register
-- states as not recorded. Nothing can be derived for them: the figures are on
-- the upplatelseavtal and the economic plan, which the board holds and this
-- database does not.
--
-- No append-only guard and no REVOKE, for the reason 20260905100000 gives
-- about the property designation: each describes the apartment as it is, a
-- renovation the board permits changes the first three, and a value recorded in
-- error has to be correctable in place. The audit log carries which fields
-- moved.

-- AlterTable
ALTER TABLE "apartment" ADD COLUMN "roomCount" INTEGER;
ALTER TABLE "apartment" ADD COLUMN "otherSpaces" TEXT;
ALTER TABLE "apartment" ADD COLUMN "livingArea" DECIMAL(6,1);
ALTER TABLE "apartment" ADD COLUMN "economicPlanRegisteredOn" DATE;

-- A room count is a count, and the service refuses anything else before it
-- gets here. Zero is allowed, because a bostadsratt can be a lokal - a
-- storeroom or a garage - with no room in it. The upper bound is a typo guard
-- rather than a statement about apartments.
ALTER TABLE "apartment"
  ADD CONSTRAINT "apartment_room_count_is_a_count"
  CHECK ("roomCount" IS NULL OR ("roomCount" >= 0 AND "roomCount" <= 99));

-- An area of nothing is not a recorded area.
ALTER TABLE "apartment"
  ADD CONSTRAINT "apartment_living_area_is_positive"
  CHECK ("livingArea" IS NULL OR "livingArea" > 0);

-- A description made only of spaces is not a recorded description, and the
-- extract would print it as an empty field that reads as a register that lost
-- one. The whitespace class is 20260828180000's, unchanged:
-- String.prototype.trim's set written out, enumerated rather than [[:space:]]
-- because that class is locale-dependent and a statutory constraint may not
-- mean different things on different deployments.
ALTER TABLE "apartment"
  ADD CONSTRAINT "apartment_other_spaces_present"
  CHECK (
    "otherSpaces" IS NULL
    OR "otherSpaces" ~ '[^\u0009-\u000D    -     　﻿]'
  );
