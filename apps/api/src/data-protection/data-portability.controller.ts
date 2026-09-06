import { Controller, HttpCode, Post, Req } from "@nestjs/common";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import {
  toDataPortabilityExport,
  type DataPortabilityExport,
} from "./data-portability";

/**
 * A person's own data, in a file they can take elsewhere (GDPR art. 20).
 *
 * The one resident-facing route in the whole of data protection, and it is
 * resident-facing for a reason the other three rights are not: an export is a
 * copy of what the person already gave, so there is nothing for the board to
 * decide. Erasure, objection and restriction are decisions the association has
 * to make and be answerable for, and those are recorded on the person's page in
 * the register by somebody who may write it.
 *
 * `self:manage`, and the person id comes from the principal alone. There is no
 * path parameter, deliberately: a route that took one would be a route where a
 * missing check hands one resident another's file, and the safest version of
 * that check is not having the parameter.
 *
 * A POST although it reads. It writes an audit entry, and the response carries
 * the person's own contact details - the same two reasons the board's access
 * report gives for not being a GET.
 */
@Controller("api/data-portability")
@RequireCapability("self:manage")
export class DataPortabilityController {
  constructor(private readonly reports: DataSubjectReportService) {}

  @Post("mine")
  @HttpCode(200)
  async exportOwnData(
    @Req() request: RequestWithPrincipal,
  ): Promise<DataPortabilityExport> {
    const principal = request.principal;
    if (principal === undefined) {
      throw new Error("The authorization guard did not attach a principal.");
    }

    return toDataPortabilityExport(
      await this.reports.portable(principal.personId),
    );
  }
}
