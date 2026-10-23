import { Module } from "@nestjs/common";

import { ImportApplyService } from "./import-apply.service";
import { ImportPlannerService } from "./import-planner.service";
import { ImportPreviewService } from "./import-preview.service";
import { ImportProposalService } from "./import-proposal.service";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

/**
 * Importing a member list, from a file a board member uploads or one a plugin
 * proposes, with a mapping the board confirms and a preview it approves.
 *
 * A plugin only proposes (ADR 0043): the file waits on the import screen, and
 * nothing is written until a board member has previewed and applied it.
 *
 * Five providers, split where the flow splits: the planner decides what an
 * import would do and is shared, the service answers the requests, the preview
 * service is the background job that plans what the board looks at, the apply
 * service is the background job that writes the register, and the proposal
 * service holds the member lists plugins hand the board to review (ADR 0043).
 */
@Module({
  controllers: [ImportController],
  providers: [
    ImportService,
    ImportPlannerService,
    ImportPreviewService,
    ImportApplyService,
    ImportProposalService,
  ],
  exports: [
    ImportService,
    ImportPreviewService,
    ImportApplyService,
    ImportProposalService,
  ],
})
export class ImportModule {}
