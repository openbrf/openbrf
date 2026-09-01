import { Module } from "@nestjs/common";

import { MeetingService } from "./meeting.service";
import { MeetingsController } from "./meetings.controller";

/**
 * The general meeting (foreningsstamma): arranging one, its agenda, who was
 * present and in what capacity, the written authorities somebody else's vote is
 * exercised under, and what the meeting decided.
 *
 * EFL 6 kap., which BRL 9 kap. 14 § applies to a housing cooperative with six
 * exceptions.
 *
 * One controller and one capability, unlike the motions module's two of each.
 * There the split is between two audiences, and one controller carrying both
 * capabilities would open a route to the wrong half of them. Here every act is
 * the board's own side of the same meeting, so a second capability would suggest
 * an audience that does not exist.
 *
 * No purge service. The other person-linked modules arrive with one because
 * their rows are held to run a service and their purpose ends when the service
 * does - a booking a year after the booked period, a motion two years after it
 * closed. An attendance line and a proxy authorisation are part of the record
 * of a general meeting: the register is taken into or appended to the protokoll
 * (EFL 6 kap. 39 §), which 40 § has kept safely, so a row erased on a clock of
 * its own would take part of the association's minutes with it. Both still have
 * a section in the data subject access report, because exemption from erasure
 * has never been exemption from access.
 *
 * The database, the audit log and the principal the controller reads all come
 * from global modules, which is why nothing is imported here.
 *
 * The service is exported for the notice, which needs the meeting it summons and
 * the agenda it states, and for the module that links a motion to the meeting it
 * is taken up at.
 */
@Module({
  controllers: [MeetingsController],
  providers: [MeetingService],
  exports: [MeetingService],
})
export class MeetingsModule {}
