import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { lockRetentionPolicy } from "../settings/retention-lock";
import { type IssueTextClocks, issueTextClocks } from "./issue-free-text";

/**
 * The board's clocks on an issue's free text, in whole years after closing:
 * the ordinary types', and a ring-fenced type's (decision 32).
 */
export type IssueRetentionView = IssueTextClocks;

/**
 * The board's settings of how long an issue's free text is kept after it
 * closes (ADR 0057, decision 33): from one to ten years, two by default, and a
 * clock of its own for a ring-fenced type, from one to ten years, one by
 * default (decision 32).
 *
 * Read by the nightly clock when it runs and never stamped on an issue, so a
 * change moves every pending date at once, as the retention policy does.
 * Audited for that reason, as `ISSUE_RETENTION_RECORDED` with the number either
 * side, one entry for each clock that changed and `ringFenced` on the entry for
 * the ring-fenced one: who shortened the time a report's words are kept, and
 * from what, is a question the log has to answer. The bounds are held by the
 * request schema, from `ISSUE_TEXT_RETENTION_YEARS` and
 * `RING_FENCED_ISSUE_TEXT_RETENTION_YEARS`, and by a CHECK on each column.
 */
@Injectable()
export class IssueRetentionSettingService {
  private readonly logger = new Logger(IssueRetentionSettingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async read(): Promise<IssueRetentionView> {
    return issueTextClocks(this.prisma);
  }

  async set(
    actorPersonId: string,
    clocks: IssueTextClocks,
  ): Promise<IssueRetentionView> {
    await this.prisma.$transaction(async (tx) => {
      // The lock the retention policy is written under, so two saves arriving
      // together each record the value they replaced.
      await lockRetentionPolicy(tx);
      const before = await tx.association.findUniqueOrThrow({
        where: { id: 1 },
        select: {
          issueTextRetentionYears: true,
          ringFencedIssueTextRetentionYears: true,
        },
      });
      const changes = [
        {
          ringFenced: false,
          from: before.issueTextRetentionYears,
          to: clocks.years,
        },
        {
          ringFenced: true,
          from: before.ringFencedIssueTextRetentionYears,
          to: clocks.ringFencedYears,
        },
      ].filter((change) => change.from !== change.to);
      if (changes.length === 0) {
        return;
      }
      await tx.association.update({
        where: { id: 1 },
        data: {
          issueTextRetentionYears: clocks.years,
          ringFencedIssueTextRetentionYears: clocks.ringFencedYears,
        },
      });
      for (const change of changes) {
        await this.audit.record(
          {
            action: "ISSUE_RETENTION_RECORDED",
            channel: "WEB",
            actorPersonId,
            targetKind: "association",
            targetId: "1",
            context: {
              // Only on the ring-fenced clock's entry, so an entry written
              // before that clock was the board's reads as the ordinary one.
              ...(change.ringFenced ? { ringFenced: true } : {}),
              yearsAfterClosingFrom: change.from,
              yearsAfterClosingTo: change.to,
            },
          },
          tx,
        );
      }
    });

    this.logger.log(
      `Issue free text kept ${String(clocks.years)} years after closing, ${String(
        clocks.ringFencedYears,
      )} for a ring-fenced type`,
    );
    return { years: clocks.years, ringFencedYears: clocks.ringFencedYears };
  }
}
