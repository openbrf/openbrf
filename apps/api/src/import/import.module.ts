import { Module } from "@nestjs/common";

import { ImportApplyService } from "./import-apply.service";
import { ImportPlannerService } from "./import-planner.service";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

/**
 * The one-time import of an existing member list.
 *
 * Recurring, differential import is a paid module (Import Pro) and is not this:
 * what ships here loads a list once, with a mapping the board confirms and a
 * preview it approves.
 *
 * Three providers, split where the flow splits: the planner decides what an
 * import would do and is shared, the service answers the requests, and the apply
 * service is the background job that writes the register.
 */
@Module({
  controllers: [ImportController],
  providers: [ImportService, ImportPlannerService, ImportApplyService],
  exports: [ImportService, ImportApplyService],
})
export class ImportModule {}
