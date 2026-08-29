import { Module } from "@nestjs/common";

import { DataSubjectReportController } from "./data-subject-report.controller";
import { DataSubjectReportService } from "./data-subject-report.service";
import { LegalHoldController } from "./legal-hold.controller";
import { LegalHoldService } from "./legal-hold.service";
import { PurgeService } from "./purge.service";

/**
 * Retention: the promise, the exception to it, and the answer to a person who
 * asks what is held about them.
 *
 * Three services that are one subject. The purge is what the retention policy
 * means in practice, the legal hold is the only lawful way to suspend it, and
 * the data subject access report is what a person is entitled to see - which
 * has to include what the purge will erase and when, or it is not an answer.
 *
 * Deliberately not inside the address book. That module is the register the
 * board works in; this one decides how long any of it is kept, reaches across
 * both tiers, and answers to GDPR rather than to EFL 5 kap. The pure retention
 * arithmetic (`purge-date.ts`, `purge-window.ts`, `retention-policy.ts`) has
 * lived in this directory since phase 1 and is imported by the address book
 * and the move flow; nothing here is imported back by them except the hold
 * state on the person payload.
 */
@Module({
  controllers: [LegalHoldController, DataSubjectReportController],
  providers: [LegalHoldService, PurgeService, DataSubjectReportService],
  exports: [LegalHoldService, PurgeService, DataSubjectReportService],
})
export class RetentionModule {}
