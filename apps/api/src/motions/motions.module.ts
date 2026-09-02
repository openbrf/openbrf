import { Module } from "@nestjs/common";

import { MotionPurgeService } from "./motion-purge.service";
import { MotionService } from "./motion.service";
import {
  MotionIntakeController,
  MotionQueueController,
} from "./motions.controller";

/**
 * Motions to the general meeting (motioner till stamman): what a member puts to
 * the meeting, the queue the board works it from, and what becomes of the record
 * that they put it.
 *
 * The intake, the queue and the purge in one module because they are one subject
 * read at three ends. A motion is a member exercising a right EFL 6 kap. 15 §
 * gives them; the queue is the board answering for it; and the record of the
 * proposal is personal data, whose retention window is part of taking motions at
 * all rather than something bolted on afterwards.
 *
 * Two controllers, one capability each, because the audiences are different: a
 * member submits and reads their own, and the board reads everybody's and records
 * that it has them. One controller carrying both capabilities would be a route
 * open to the wrong half of them.
 *
 * The database, the audit log, the job queue and the principal the controllers
 * read all come from global modules, which is why nothing is imported here.
 *
 * The service is exported for the screens and endpoints that read the queue
 * without being the ones that write it. Linking a motion to the meeting that
 * takes it up is one of this module's own acts rather than the meetings
 * module's: the item belongs to the queue the board works, and the two facts
 * the refusal turns on - whether the meeting has been held, and whether its
 * notice has been issued - are columns this service reads for itself.
 *
 * One thing does come from the meetings module, and it is not a provider: the
 * key of the advisory lock that serialises this link against the notice being
 * issued (`meetings/agenda-lock.ts`). Both writers have to take the same key or
 * there are two locks and no guarantee, so that key is imported rather than
 * spelled twice. Nothing is imported into the Nest module for it, because a
 * lock helper is a function over the caller's own transaction.
 */
@Module({
  controllers: [MotionIntakeController, MotionQueueController],
  providers: [MotionService, MotionPurgeService],
  exports: [MotionService],
})
export class MotionsModule {}
