-- Resource booking (bokning): what the association offers its residents, and
-- who has booked it.
--
-- Service tier throughout. Neither table gets an append-only trigger, a
-- TRUNCATE guard or a REVOKE in harden-runtime-role.sql, because neither holds
-- statutory register content: the catalogue is the association's account of
-- what it offers, and a booking is personal data held for a service purpose
-- that the booking purge erases once the booking has ended.

-- CreateEnum
CREATE TYPE "BookingResourceMode" AS ENUM ('TIME_SLOTS', 'WHOLE_DAY', 'DATE_RANGE');

-- CreateEnum
--
-- RELEASED is reserved schema room. Nothing in the core writes it: there is no
-- auto-release and no access system to hear from. The value is here so that the
-- day something needs it, the type does not have to be altered underneath live
-- bookings - an ALTER TYPE cannot run in the same transaction as a statement
-- that uses the value it adds, which is why enum growth is its own migration.
CREATE TYPE "BookingStatus" AS ENUM ('BOOKED', 'CANCELLED', 'RELEASED');

-- CreateTable
CREATE TABLE "bookable_resource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mode" "BookingResourceMode" NOT NULL,
    "slotMinutes" INTEGER,
    "opensAtMinute" INTEGER,
    "closesAtMinute" INTEGER,
    "maxConcurrentBookings" INTEGER,
    "maxBookingsPerWeek" INTEGER,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookable_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- bookedByPersonId is a plain column and not a foreign key, for the reason
-- issue."reporterPersonId" and audit_log_entry."actorPersonId" are: every
-- referential action available either rewrites this row when a person is
-- erased or vetoes the erasure outright, and service-tier data must be
-- purgeable without the purge having to negotiate with the booking calendar.
CREATE TABLE "booking" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "apartmentId" TEXT,
    "bookedByPersonId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'BOOKED',
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookable_resource_deactivatedAt_name_idx" ON "bookable_resource"("deactivatedAt", "name");

-- CreateIndex
CREATE INDEX "booking_resourceId_startsAt_idx" ON "booking"("resourceId", "startsAt");

-- CreateIndex
CREATE INDEX "booking_bookedByPersonId_startsAt_idx" ON "booking"("bookedByPersonId", "startsAt");

-- CreateIndex
CREATE INDEX "booking_apartmentId_startsAt_idx" ON "booking"("apartmentId", "startsAt");

-- CreateIndex
CREATE INDEX "booking_status_endsAt_idx" ON "booking"("status", "endsAt");

-- CreateIndex
--
-- The double booking is refused here, by the database, and not by a read the
-- application took a moment before it wrote. Two residents claiming the same
-- laundry hour in the same instant are sorted out by this index: one insert
-- succeeds and the other raises a unique violation.
--
-- Partial on purpose. A plain unique index over the pair would let a cancelled
-- booking keep its time for ever, so an hour somebody changed their mind about
-- could never be booked by anyone again. WHERE status = 'BOOKED' means exactly
-- one live booking per resource and start time, with any number of cancelled or
-- released rows beside it.
--
-- Written by hand because Prisma cannot express a WHERE clause on an index, and
-- with no @@unique counterpart in schema.prisma: the constraint Prisma is able
-- to express is not the constraint this table needs. The model comment on
-- Booking says so, so that nobody adds the expressible one later.
CREATE UNIQUE INDEX "booking_resourceId_startsAt_booked_key"
    ON "booking" ("resourceId", "startsAt")
    WHERE "status" = 'BOOKED'::"BookingStatus";

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "bookable_resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
