import { Module } from "@nestjs/common";

import { ActionsModule } from "../actions/actions.module";
import { MediaModule } from "../media/media.module";
import { IssueActionsRegistrar } from "./issue-actions.registrar";
import { IssueConversationService } from "./issue-conversation.service";
import { IssueErasureService } from "./issue-erasure.service";
import { IssueFreeTextService } from "./issue-free-text.service";
import { IssuePurgeService } from "./issue-purge.service";
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
  IssueQueueController,
  IssueReportController,
  IssueSavedReplyAdminController,
  IssueTypeAdminController,
  ResponsibilityGuideAdminController,
} from "./issues.controller";
import { ResponsibilityGuideService } from "./responsibility-guide.service";

/**
 * Reported issues: the board's type catalogue, the resident's report, the
 * queue whoever handles issues works from, the resident picker a handler
 * names a resident from on an issue they open, the conversation on an
 * issue - its messages, the handlers' notes and files, and the saved replies -
 * and the association's responsibility guide, read before filing and when
 * deciding who pays.
 *
 * MediaModule is imported for the photographs, and ActionsModule for the
 * queue's read actions (ADR 0040), which is not global because the registry is
 * the one thing a plugin may never hold. The database, the field encryption
 * and the principal the controllers read come from the global modules, which
 * is why they are not listed here.
 *
 * The services are exported because the association's public website renders
 * the report form itself, in process, rather than calling this API over HTTP,
 * and the saved replies because the setup wizard seeds them.
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
    ResponsibilityGuideAdminController,
    IssueSavedReplyAdminController,
    IssueRedactionController,
    IssueRetentionController,
  ],
  providers: [
    IssueService,
    IssueTypeService,
    IssuePurgeService,
    IssueResidentsService,
    IssueConversationService,
    IssueSavedReplyService,
    IssueFreeTextService,
    IssueTextPurgeService,
    IssueErasureService,
    IssueRedactionService,
    IssueRetentionSettingService,
    IssueActionsRegistrar,
    ResponsibilityGuideService,
  ],
  exports: [
    IssueService,
    IssueTypeService,
    IssueSavedReplyService,
    ResponsibilityGuideService,
  ],
})
export class IssuesModule {}
