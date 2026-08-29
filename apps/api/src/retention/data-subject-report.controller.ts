import { Controller, HttpCode, Param, Post, Req } from "@nestjs/common";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import type { DataSubjectReport } from "./data-subject-report";
import { DataSubjectReportService } from "./data-subject-report.service";

/**
 * The data subject access report (registerutdrag, GDPR art. 15).
 *
 * One route, and every constraint on it is deliberate.
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
 */
@Controller("api/data-subject-reports")
@RequireCapability("addressBook:read", "protectedData:reveal")
export class DataSubjectReportController {
  constructor(private readonly reports: DataSubjectReportService) {}

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
}
