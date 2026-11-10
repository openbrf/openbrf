import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import {
  ISSUE_ACCESS_PARTS,
  ISSUE_ACCESS_WITHHOLDING_REASONS,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import type { DataSubjectReport } from "./data-subject-report";
import { DataSubjectReportService } from "./data-subject-report.service";
import {
  IssueAccessWeighingService,
  type IssueAccessWeighingView,
} from "./issue-access-weighing.service";

/**
 * A weighing as the board sends it: every text it weighed, each given or left
 * out for a reason. A text the board did not send stays unweighed. Bounded far
 * above any issue's texts, so a body cannot be made a load.
 */
const weighingSchema = z.object({
  decisions: z
    .array(
      z.object({
        part: z.enum(ISSUE_ACCESS_PARTS),
        id: z.string().min(1).max(64).nullable(),
        withheldBecause: z.enum(ISSUE_ACCESS_WITHHOLDING_REASONS).nullable(),
      }),
    )
    .max(2000),
});

/**
 * The data subject access report (registerutdrag, GDPR art. 15).
 *
 * One route for the report, and every constraint on it is deliberate; and two
 * for the board's art. 15(4) weighing of an issue's text for it, under the
 * same gate, because weighing is part of producing the report.
 *
 * `protectedData:reveal` is the gate. The report decrypts the email address,
 * the phone number and the personal identity number of one person onto one
 * document, which is the class of act that capability exists for; it is not
 * covered by `addressBook:read`, which is the everyday board view where all
 * three are masked.
 *
 * A POST although it reads, for the two reasons the reveal route gives: it
 * writes an audit entry, and the response carries personal data that must not
 * sit in a URL, a proxy log or a browser history.
 *
 * No `@Public()` route and no email delivery, here or anywhere. The report is
 * produced inside the signed-in application, printed by the board member who
 * produced it, and handed over. A copy mailed instead would pass through two
 * mail systems carrying a personal identity number.
 *
 * Gathered in one of the few slots the members' own exports are gathered in
 * too, because the report holds a database connection for the length of its
 * transaction. A request that finds every slot taken is answered 429
 * `export-busy` with a `Retry-After`, before anything is read and without an
 * audit entry. There is no per-person budget: the route is held by the board
 * and an administrator, and the slots are what bound the connections.
 */
@Controller("api/data-subject-reports")
@RequireCapability("addressBook:read", "protectedData:reveal")
export class DataSubjectReportController {
  constructor(
    private readonly reports: DataSubjectReportService,
    private readonly weighings: IssueAccessWeighingService,
  ) {}

  @Post("persons/:personId")
  @HttpCode(200)
  async generate(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
  ): Promise<DataSubjectReport> {
    return this.reports.generate({
      personId,
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * The texts of one issue that this person's report weighs, with their words,
   * for the board to weigh under art. 15(4) (ADR 0057): the internal notes on
   * an issue they reported, every text of one a handler recorded as
   * concerning them. Never part of the report itself, which carries only
   * what the board gave.
   *
   * A read without an audit entry of its own: it is a step in producing the
   * report, whose own entry records that, and the weighing it leads to is
   * recorded when saved.
   */
  @Get("persons/:personId/issues/:issueId/weighing")
  // The words of the case, which no browser cache may keep.
  @Header("Cache-Control", "no-store")
  async weighing(
    @Param("personId") personId: string,
    @Param("issueId") issueId: string,
  ): Promise<IssueAccessWeighingView> {
    return this.weighings.read(personId, issueId);
  }

  /**
   * Records the board's weighing of the issue for this person's report,
   * replacing the one before it, and answers the texts as now weighed. The
   * report is produced again to show it.
   */
  @Put("persons/:personId/issues/:issueId/weighing")
  async weigh(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Param("issueId") issueId: string,
    @Body() body: unknown,
  ): Promise<IssueAccessWeighingView> {
    return this.weighings.weigh({
      personId,
      issueId,
      actorPersonId: actingPersonId(request),
      decisions: weighingSchema.parse(body).decisions,
    });
  }
}
