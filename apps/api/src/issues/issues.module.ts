import { Module } from "@nestjs/common";

import { ActionsModule } from "../actions/actions.module";
import { MediaModule } from "../media/media.module";
import { IssueActionsRegistrar } from "./issue-actions.registrar";
import { IssueConversationService } from "./issue-conversation.service";
import { IssueFitService } from "./issue-fit.service";
import { IssuePlaceService } from "./issue-place.service";
import { IssueErasureService } from "./issue-erasure.service";
import { IssueFileSweepService } from "./issue-file-sweep.service";
import { IssueFreeTextService } from "./issue-free-text.service";
import { IssueMailer } from "./issue-mailer.service";
import { IssuePurgeService } from "./issue-purge.service";
import { IssueReporterLinkService } from "./issue-reporter-link.service";
import { IssueRedactionService } from "./issue-redaction.service";
import { IssueRetentionSettingService } from "./issue-retention-setting.service";
import {
  IssueRedactionController,
  IssueRetentionController,
} from "./issue-retention.controller";
import { IssueResidentsService } from "./issue-residents.service";
import { IssueSavedReplyService } from "./issue-saved-reply.service";
import { IssueTextPurgeService } from "./issue-text-purge.service";
import { IssueTypeService } from "./issue-type.service";
import { IssueService } from "./issue.service";
import {
  IssuePlaceAdminController,
  IssueQueueController,
  IssueReportController,
  IssueSavedReplyAdminController,
  IssueTypeAdminController,
  ResponsibilityGuideAdminController,
} from "./issues.controller";
import { ContractorService } from "./contractor.service";
import { WorkOrderMailerService } from "./work-order-mailer.service";
import { WorkOrderService } from "./work-order.service";
import {
  ContractorAdminController,
  IssueWorkOrderController,
} from "./work-orders.controller";
import { ResponsibilityGuideService } from "./responsibility-guide.service";

/**
 * Reported issues: the board's type catalogue, the resident's report, the
 * queue whoever handles issues works from, the resident picker a handler
 * names a resident from on an issue they open, the conversation on an
 * issue - its messages, the handlers' notes and files, and the saved replies -
 * the contractors a handler sends a work order to, with the record of what was
 * sent, the association's responsibility guide, read before filing and when
 * deciding who pays, and the mail and the overdue reminder that tell
 * handlers of their issues (`IssueMailer`).
 *
 * MediaModule is imported for the photographs, and ActionsModule for the
 * queue's read actions (ADR 0040), which is not global because the registry is
 * the one thing a plugin may never hold. The database, the field encryption
 * and the principal the controllers read come from the global modules, which
 * is why they are not listed here.
 *
 * The services are exported because the association's public website renders
 * the report form itself, in process, rather than calling this API over HTTP,
 * the saved replies because the setup wizard seeds them, and the reporter's
 * private link because its page is the website's too (ADR 0055).
 *
 * IssuePurgeService is a provider and not exported: it is a scheduled job with
 * nobody to call it, and the integration suite reaches it through the module
 * reference the way it reaches every other purge in the band. So is
 * IssueFileSweepService, which removes the files an upload stored and never
 * put on an issue or a work order.
 */
@Module({
  imports: [ActionsModule, MediaModule],
  controllers: [
    IssueReportController,
    IssueQueueController,
    IssueTypeAdminController,
    IssueWorkOrderController,
    ContractorAdminController,
    ResponsibilityGuideAdminController,
    IssueSavedReplyAdminController,
    IssuePlaceAdminController,
    IssueRedactionController,
    IssueRetentionController,
  ],
  providers: [
    IssueService,
    IssueMailer,
    IssueTypeService,
    IssuePurgeService,
    IssueResidentsService,
    IssueConversationService,
    IssueSavedReplyService,
    IssueFitService,
    IssuePlaceService,
    IssueReporterLinkService,
    IssueFreeTextService,
    IssueTextPurgeService,
    IssueFileSweepService,
    IssueErasureService,
    IssueRedactionService,
    IssueRetentionSettingService,
    IssueActionsRegistrar,
    ContractorService,
    WorkOrderService,
    WorkOrderMailerService,
    ResponsibilityGuideService,
  ],
  exports: [
    IssueService,
    IssueTypeService,
    IssueSavedReplyService,
    IssuePlaceService,
    IssueReporterLinkService,
    ResponsibilityGuideService,
  ],
})
export class IssuesModule {}
