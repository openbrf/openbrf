import { Module } from "@nestjs/common";

import { EventSignupPurgeService } from "./event-signup-purge.service";
import { EventSignupService } from "./event-signup.service";
import {
  EventAttendanceAdminController,
  EventSignupController,
} from "./event-signups.controller";
import { EventService } from "./event.service";
import { EventAdminController } from "./events.controller";

/**
 * The event calendar (evenemangskalender): what the association arranges, when
 * it happens, who is told about it, and who is coming.
 *
 * One series and the dates it falls on are one subject, so they are one service.
 * The dates are rows rather than a computed calendar because a sign-up attaches
 * to one of them - which is the difference between this module and the booking
 * module's generated slots.
 *
 * The sign-ups are a second service beside it rather than more methods on the
 * first, because they are a different subject: the series is the association's
 * own account of what it arranges, and a sign-up is personal data about a
 * resident, with a retention window, a purge and a section in the access report
 * of its own. The one place the two meet is the refusal to reshape a date
 * somebody is standing on, and that meeting is a single function -
 * `event-attendance.ts` - rather than a dependency between the services.
 *
 * The purge is here rather than in the retention module, for the reason the
 * booking purge is in the booking module: how long a sign-up is kept is part of
 * offering sign-ups at all, not something bolted on afterwards.
 *
 * Three controllers, one capability each, because the audiences are different:
 * the board arranges and announces, a resident signs themselves up and reads how
 * many places are left, and who is coming is the board's again. One controller
 * carrying two of those capabilities would be a route open to the wrong half of
 * the house.
 *
 * The database, the audit log, the job queue and the principal the controllers
 * read all come from global modules, which is why nothing is imported here.
 *
 * The services are exported for the endpoints that read the calendar without
 * being the ones that write it.
 */
@Module({
  controllers: [
    EventAdminController,
    EventSignupController,
    EventAttendanceAdminController,
  ],
  providers: [EventService, EventSignupService, EventSignupPurgeService],
  exports: [EventService, EventSignupService],
})
export class EventsModule {}
