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
 * without being the ones that write it - and for the module that will link a
 * motion to the meeting it was taken up at, which arrives with the notice that
 * puts the item on one.
 */
@Module({
  controllers: [MotionIntakeController, MotionQueueController],
  providers: [MotionService, MotionPurgeService],
  exports: [MotionService],
})
export class MotionsModule {}
