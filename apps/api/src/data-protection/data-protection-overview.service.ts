import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import { breachState, computeBreachDeadline } from "./breach-deadline";
import { dueOn } from "./data-subject-request";
import { PrivacyNoticeService } from "./privacy-notice.service";
import { ProcessorAgreementService } from "./processor-agreement.service";
import { ProcessorFactsService } from "./processor-facts.service";

/** What the board sees at the top of the data protection screen. */
export interface DataProtectionOverview {
  breaches: {
    awaitingDecision: number;
    overdue: number;
    /** The nearest 72-hour bound still running, as an ISO instant. */
    nearestDeadline: string | null;
  };
  requests: { open: number; overdue: number };
  processors: { notRecorded: number; pending: number };
  notice: { missingHeadings: number; published: boolean };
}

/**
 * The four sentences the board reads before it reads anything else.
 *
 * Every count is derived from the same functions the screens behind it use, so
 * the strip and the panel cannot disagree: a strip saying nothing is waiting
 * over a register with an overdue breach in it would be worse than no strip.
 *
 * Nothing here is a stored counter. A count kept in a column goes wrong exactly
 * when it matters - the night a deadline passes and nothing recomputes it - and
 * these are cheap: a cooperative has a handful of each of these rows in its
 * lifetime.
 */
@Injectable()
export class DataProtectionOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notice: PrivacyNoticeService,
    private readonly processors: ProcessorAgreementService,
    private readonly facts: ProcessorFactsService,
  ) {}

  async read(now: Date = new Date()): Promise<DataProtectionOverview> {
    const [breaches, requests, coverage, processors] = await Promise.all([
      this.prisma.personalDataBreach.findMany({
        where: { decidedAt: null, closedAt: null },
        select: { discoveredAt: true, decidedAt: true, closedAt: true },
      }),
      this.prisma.dataSubjectRequest.findMany({
        where: { decision: null, closedAt: null },
        select: { requestedOn: true },
      }),
      this.notice.coverage(),
      this.facts.read().then((facts) => this.processors.list(facts)),
    ]);

    const overdueBreaches = breaches.filter(
      (breach) => breachState(breach, now) === "overdue",
    ).length;

    const deadlines = breaches
      .map((breach) => computeBreachDeadline(breach.discoveredAt).getTime())
      .sort((left, right) => left - right);

    return {
      breaches: {
        awaitingDecision: breaches.length,
        overdue: overdueBreaches,
        nearestDeadline:
          deadlines[0] === undefined
            ? null
            : new Date(deadlines[0]).toISOString(),
      },
      requests: {
        open: requests.length,
        // Past the month art. 12(3) gives, and still owed: an overdue answer is
        // not an answer the association no longer has to give.
        overdue: requests.filter(
          (request) => dueOn(request.requestedOn).getTime() < now.getTime(),
        ).length,
      },
      processors: {
        notRecorded: processors.filter(
          (processor) => processor.state === "notRecorded",
        ).length,
        pending: processors.filter((processor) => processor.state === "pending")
          .length,
      },
      notice: {
        missingHeadings: coverage.sections.filter((section) => !section.present)
          .length,
        published: coverage.published,
      },
    };
  }
}
