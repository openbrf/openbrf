import { Module } from "@nestjs/common";

import { ActionsModule } from "../actions/actions.module";
import { MediaModule } from "../media/media.module";
import { IssueActionsRegistrar } from "./issue-actions.registrar";
import { IssuePurgeService } from "./issue-purge.service";
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
 * MediaModule is imported for the photographs, and ActionsModule for the
 * queue's read actions (ADR 0040), which is not global because the registry is
 * the one thing a plugin may never hold. The database, the field encryption
 * and the principal the controllers read come from the global modules, which
 * is why they are not listed here.
 *
 * The services are exported because the association's public website renders
 * the report form itself, in process, rather than calling this API over HTTP.
 *
 * IssuePurgeService is a provider and not exported: it is a scheduled job with
 * nobody to call it, and the integration suite reaches it through the module
 * reference the way it reaches every other purge in the band.
 */
@Module({
  imports: [ActionsModule, MediaModule],
  controllers: [
    IssueReportController,
    IssueQueueController,
    IssueTypeAdminController,
  ],
  providers: [
    IssueService,
    IssueTypeService,
    IssuePurgeService,
    IssueActionsRegistrar,
  ],
  exports: [IssueService, IssueTypeService],
})
export class IssuesModule {}
