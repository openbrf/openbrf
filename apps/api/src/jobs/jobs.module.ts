import { Global, Module } from "@nestjs/common";

import { JobQueueService } from "./job-queue.service";

/**
 * Import, move-out reminders and plugin installation all run as jobs, so the
 * queue is provided globally like the other infrastructure modules.
 */
@Global()
@Module({
  providers: [JobQueueService],
  exports: [JobQueueService],
})
export class JobsModule {}
