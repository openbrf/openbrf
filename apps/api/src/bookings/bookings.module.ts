import { Module } from "@nestjs/common";

import { BookableResourceService } from "./bookable-resource.service";
import { BookingPurgeService } from "./booking-purge.service";
import { BookableResourceAdminController } from "./bookings.controller";

/**
 * Resource booking (bokning): what the association offers, and what becomes of
 * the record that somebody booked it.
 *
 * The catalogue and the purge in one module because they are one subject read
 * at two ends. A resource is the association's own account of what the house
 * has; a booking is personal data held to run that, and the retention window on
 * it is part of offering it at all rather than something bolted on afterwards.
 *
 * The database, the audit log, the job queue and the principal the controller
 * reads all come from global modules, which is why nothing is imported here.
 *
 * The resource service is exported for the screens and endpoints that read the
 * catalogue without configuring it.
 */
@Module({
  controllers: [BookableResourceAdminController],
  providers: [BookableResourceService, BookingPurgeService],
  exports: [BookableResourceService],
})
export class BookingsModule {}
