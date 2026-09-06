-- Key orders (nyckelbestallning): what a resident asks the board for, and the
-- handover the board records.
--
-- No statute stands behind this one, and that is the difference from the
-- subletting application beside it. A key to the entrance or a tag to the bike
-- room is the association's own service to the household that lives here, so the
-- right is a resident's rather than a member's and the board may decline an
-- order outright - where refusing a member's motion or refusing consent without
-- befogad anledning both answer to a paragraph.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql: the table records one order and its
-- handover, and the key purge erases a closed order once its window has run out.
--
-- Deliberately no amount, no price and no invoice. What a key costs the member
-- is a charge (debitering), which is its own feature with its own model, its own
-- VAT treatment and its own export to whoever keeps the association's books - and
-- a second place recording a sum would be a second answer to what the member
-- owes. The join, when it is made, is from a charge to the order it is the basis
-- for.

-- CreateEnum
--
-- Two kinds, because two is what a household actually orders: a cut key
-- (nyckel) and an electronic tag (tagg, passerbricka). Which door it opens is
-- the note below rather than a third value - the doors a building has are the
-- board's own list and inventing an enum over them would be the platform
-- describing a building it has never seen.
CREATE TYPE "KeyOrderKind" AS ENUM ('KEY', 'TAG');

-- CreateEnum
--
-- HANDED_OVER rather than a "done": the act the board records is a handover to a
-- named person on a day, which is the whole point of keeping the record.
-- DECLINED exists here and has no counterpart in the motion queue, because
-- nothing gives a resident a right to a key.
CREATE TYPE "KeyOrderStatus" AS ENUM ('SUBMITTED', 'HANDED_OVER', 'DECLINED', 'WITHDRAWN');

-- CreateTable
--
-- orderedByPersonId and closedByPersonId are plain columns and not foreign
-- keys, for the reason issue."reporterPersonId" and booking."bookedByPersonId"
-- are: every referential action available either rewrites this row when a person
-- is erased or vetoes the erasure outright, and service-tier data must be
-- purgeable without the purge having to negotiate with the key queue.
CREATE TABLE "key_order" (
    "id" TEXT NOT NULL,

    -- Whoever ordered it. A resident rather than a member: a partner, an adult
    -- child and a tenant all need to get through the front door, and the key is
    -- the household's business with the association rather than a right the
    -- tenant-ownership carries.
    "orderedByPersonId" TEXT NOT NULL,

    -- The apartment the key belongs to.
    --
    -- Nullable with ON DELETE SET NULL, exactly as issue."apartmentId" and
    -- booking."apartmentId" are: an apartment corrected out of the register must
    -- not be held hostage by an order handed over last spring.
    "apartmentId" TEXT,

    "kind" "KeyOrderKind" NOT NULL,

    -- How many. Bounded rather than free, because an order for a household is a
    -- handful and a four-figure quantity is a typed mistake the board would
    -- otherwise have to catch by reading.
    "quantity" INTEGER NOT NULL DEFAULT 1,

    -- Which door, or what the resident wants it for.
    --
    -- Optional: a tag for the entrance needs no explanation and a form that
    -- insisted on one would collect a line of nothing. Resident-written free
    -- text, so it is scanned for a personal identity number on the way in and on
    -- every later revision - an order placed for somebody else in the household
    -- is where a number gets written down without anybody deciding to.
    "note" TEXT,

    "status" "KeyOrderStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- When the order stopped being open, whichever way it closed, and who closed
    -- it. For a handover that is the recorded act itself: the board member who
    -- handed the key over, and when.
    "closedAt" TIMESTAMP(3),
    "closedByPersonId" TEXT,

    -- What the board said when it answered. Scanned like the resident's own
    -- note, because it travels back to them and onto their access report.
    "boardNote" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_order_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "key_order"
  ADD CONSTRAINT "key_order_apartmentId_fkey"
  FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A quantity a household could plausibly want.
--
-- The API refuses this first and with a reason code, so a violation here is
-- reachable only by a hand-written statement - which is exactly the case the
-- constraint is for, and why losing the reason to SQLSTATE 23514 costs nothing.
ALTER TABLE "key_order" ADD CONSTRAINT "key_order_quantity_check"
  CHECK ("quantity" BETWEEN 1 AND 10);

-- CreateIndex
--
-- The board's queue, a resident's own orders, the purge scan, and the orders
-- standing against one apartment, in that order.
CREATE INDEX "key_order_status_submittedAt_idx" ON "key_order"("status", "submittedAt");
CREATE INDEX "key_order_orderedByPersonId_submittedAt_idx" ON "key_order"("orderedByPersonId", "submittedAt");
CREATE INDEX "key_order_closedAt_idx" ON "key_order"("closedAt");
CREATE INDEX "key_order_apartmentId_idx" ON "key_order"("apartmentId");
