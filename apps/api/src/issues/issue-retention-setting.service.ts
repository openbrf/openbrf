import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { lockRetentionPolicy } from "../settings/retention-lock";
import { issueTextRetentionYears } from "./issue-free-text";

/** The board's clock on an issue's free text, in whole years after closing. */
export interface IssueRetentionView {
  years: number;
}

/**
 * The board's setting of how long an issue's free text is kept after it
 * closes (ADR 0057, decision 33): from one to ten years, two by default.
 *
 * Read by the nightly clock when it runs and never stamped on an issue, so a
 * change moves every pending date at once, as the retention policy does.
 * Audited for that reason, as `ISSUE_RETENTION_RECORDED` with the number either
 * side: who shortened the time a report's words are kept, and from what, is a
 * question the log has to answer. The bounds are held by the request schema,
 * from `ISSUE_TEXT_RETENTION_YEARS`, and by a CHECK on the column.
 */
@Injectable()
export class IssueRetentionSettingService {
  private readonly logger = new Logger(IssueRetentionSettingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async read(): Promise<IssueRetentionView> {
    return { years: await issueTextRetentionYears(this.prisma) };
  }

  async set(actorPersonId: string, years: number): Promise<IssueRetentionView> {
    await this.prisma.$transaction(async (tx) => {
      // The lock the retention policy is written under, so two saves arriving
      // together each record the value they replaced.
      await lockRetentionPolicy(tx);
      const before = await tx.association.findUniqueOrThrow({
        where: { id: 1 },
        select: { issueTextRetentionYears: true },
      });
      if (before.issueTextRetentionYears === years) {
        return;
      }
      await tx.association.update({
        where: { id: 1 },
        data: { issueTextRetentionYears: years },
      });
      await this.audit.record(
        {
          action: "ISSUE_RETENTION_RECORDED",
          channel: "WEB",
          actorPersonId,
          targetKind: "association",
          targetId: "1",
          context: {
            yearsAfterClosingFrom: before.issueTextRetentionYears,
            yearsAfterClosingTo: years,
          },
        },
        tx,
      );
    });

    this.logger.log(
      `Issue free text kept ${String(years)} years after closing`,
    );
    return { years };
  }
}
