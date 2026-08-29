import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import { IssueTypeService } from "./issue-type.service";
import { IssueService } from "./issue.service";
import {
  IssueQueueController,
  IssueReportController,
  IssueTypeAdminController,
} from "./issues.controller";

/**
 * Reported issues: the board's type catalogue, the resident's report, and the
 * queue whoever handles issues works from.
 *
 * MediaModule is imported for the photographs. The database, the field
 * encryption and the principal the controllers read come from the global
 * modules, which is why they are not listed here.
 *
 * The services are exported because the association's public website renders
 * the report form itself, in process, rather than calling this API over HTTP.
 */
@Module({
  imports: [MediaModule],
  controllers: [
    IssueReportController,
    IssueQueueController,
    IssueTypeAdminController,
  ],
  providers: [IssueService, IssueTypeService],
  exports: [IssueService, IssueTypeService],
})
export class IssuesModule {}
