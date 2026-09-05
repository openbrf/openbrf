-- A transfer says whether it is an upplatelse or an overgang.
--
-- Bostadsrattslagen distinguishes them - the association grants a bostadsratt
-- under 4 kap., and that right passes between holders under 6 kap. - and the
-- cooperative housing register reports them under different paragraphs on
-- different clocks (Lag (2026:484) 3 kap. 2 § and 3 §). This table held both
-- and said which only by implication: a grant has no seller.
--
-- That implication was wrong often enough to matter. A register that began part
-- way through a building's life holds transfers whose seller it never recorded,
-- and those carry a null seller too. So an upplatelse and a transfer out of an
-- unknown hand were the same row, and the platform could not raise the duty
-- 3 kap. 2 § lays on the association for the first without risking it on the
-- second.
--
-- Nullable, and no backfill. What a row written before this column was is not
-- recorded anywhere, and there is nothing to derive it from: the association's
-- own decision to grant is minuted on paper, and the register does not hold it.
-- A guessed kind in a statutory register is a statement nobody made, which is
-- the reasoning transfer."membershipDecidedOn" and "agreementReference" already
-- carry.
--
-- The CHECK is therefore NOT VALID: every new row must state a kind, and the
-- rows already here stay as they are. Exactly the shape
-- 20260828170000_transfer_agreement_reference_required uses, for the same
-- reason and on the same table.
CREATE TYPE "TransferKind" AS ENUM ('GRANT', 'TRANSFER');

ALTER TABLE "transfer" ADD COLUMN "kind" "TransferKind";

ALTER TABLE "transfer"
  ADD CONSTRAINT "transfer_kind_recorded"
  CHECK ("kind" IS NOT NULL)
  NOT VALID;

-- A grant has no seller.
--
-- The right comes into being; there is no holder before it for one to pass
-- from, and the association is not a party this register records. A GRANT
-- naming a seller is an overgang somebody labelled wrong, and it would put a
-- deadline on 3 kap. 2 §'s clock that belongs on 3 kap. 3 §'s.
--
-- Valid rather than NOT VALID: the expression is NULL for every row written
-- before "kind" existed, and a CHECK passes on NULL, so the existing rows
-- satisfy it without anything being assumed about them.
ALTER TABLE "transfer"
  ADD CONSTRAINT "transfer_grant_has_no_seller"
  CHECK ("kind" IS DISTINCT FROM 'GRANT' OR "fromPersonId" IS NULL);
