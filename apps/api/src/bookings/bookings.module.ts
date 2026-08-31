import { Module } from "@nestjs/common";

import { BookableResourceService } from "./bookable-resource.service";
import { BookingPurgeService } from "./booking-purge.service";
import { BookingService } from "./booking.service";
import {
  BookableResourceAdminController,
  BookingAdminController,
  BookingController,
} from "./bookings.controller";

/**
 * Resource booking (bokning): what the association offers, who has booked it,
 * and what becomes of the record that they did.
 *
 * The catalogue, the calendar and the purge in one module because they are one
 * subject read at three ends. A resource is the association's own account of
 * what the house has; a booking is a claim on it; and the record of that claim
 * is personal data, whose retention window is part of offering the thing at all
 * rather than something bolted on afterwards.
 *
 * Three controllers, one capability each, because the audiences are different:
 * a resident books and reads their own, the board reads and cancels anybody's,
 * and configuring the catalogue is a third act again. One controller carrying
 * two of those capabilities would be a route open to the wrong half of them.
 *
 * The database, the audit log, the job queue and the principal the controllers
 * read all come from global modules, which is why nothing is imported here.
 *
 * The services are exported for the screens and endpoints that read the
 * catalogue or the calendar without being the ones that write them.
 */
@Module({
  controllers: [
    BookingController,
    BookingAdminController,
    BookableResourceAdminController,
  ],
  providers: [BookableResourceService, BookingService, BookingPurgeService],
  exports: [BookableResourceService, BookingService],
})
export class BookingsModule {}
