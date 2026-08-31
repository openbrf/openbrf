import { Module } from "@nestjs/common";

import { EventService } from "./event.service";
import { EventAdminController } from "./events.controller";

/**
 * The event calendar (evenemangskalender): what the association arranges, when
 * it happens, and who is told about it.
 *
 * One series and the dates it falls on are one subject, so they are one service.
 * The dates are rows rather than a computed calendar because a sign-up attaches
 * to one of them - which is the difference between this module and the booking
 * module's generated slots.
 *
 * One controller, because there is one audience so far: the board, which
 * arranges and announces. Reading the calendar as a resident and signing up to a
 * date are a second audience with a capability of their own, and they arrive with
 * their own controller rather than as routes on this one.
 *
 * The database, the audit log and the principal the controller reads all come
 * from global modules, which is why nothing is imported here.
 *
 * The service is exported for the endpoints that read the calendar without being
 * the ones that write it.
 */
@Module({
  controllers: [EventAdminController],
  providers: [EventService],
  exports: [EventService],
})
export class EventsModule {}
