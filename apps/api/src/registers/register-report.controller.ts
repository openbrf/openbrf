import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "./acting-person";
import {
  type InitialSupply,
  InitialSupplyService,
} from "./initial-supply.service";
import {
  type RegisterReportDuty,
  type RegisterReportQueue,
  RegisterReportService,
} from "./register-report.service";

/** ISO calendar date. A statutory date of record is never guessed from prose. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const reportMadeSchema = z.object({
  obligationId: z.string().min(1),
  /** The day the anmalan reached Lantmateriet, as the board member states it. */
  reportedOn: isoDate,
});

/**
 * What the association still owes the cooperative housing register.
 *
 * Its own path and its own controller rather than a route on the apartment
 * register's, because it is a different document under a different act: the
 * apartment register is the association's own record under BRL 9 kap., and this
 * is the queue of duties Lag (2026:484) 3 kap. puts on it towards Lantmateriet.
 *
 * Gated on `apartmentRegister:read` alone. A duty carries an apartment
 * designation and two statutory dates and no personal data at all, so it needs
 * neither `protectedData:reveal` nor the export capability - and a board that
 * had to hold the disclosure capability to see which deadlines are running would
 * either look too rarely or hold the disclosure too widely. The initial supply,
 * which does carry a personal identity number, is a separate controller below.
 */
@Controller("api/register-reports")
@RequireCapability("apartmentRegister:read")
export class RegisterReportController {
  constructor(private readonly reports: RegisterReportService) {}

  @Get()
  async queue(): Promise<RegisterReportQueue> {
    return this.reports.queue();
  }

  /**
   * Records that the anmalan for one duty reached Lantmateriet.
   *
   * Behind the same pair of capabilities as every other write to a statutory
   * register, and for the reason those routes give: writing needs more than the
   * right to read. What it writes is an audit entry rather than a register row -
   * the obligation ledger is append-only and a discharged duty has no later
   * state to reach there - and an entry cannot be corrected either, so the date
   * is checked before it goes in and a second statement is refused.
   */
  @Post("reported")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async recordReportMade(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<RegisterReportDuty> {
    return this.reports.recordReportMade({
      ...reportMadeSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
  }
}

/**
 * The initial supply to the cooperative housing register (Lag (2026:485) 3 §).
 *
 * A separate controller with a capability of its own, because it is the only
 * route in this module that decrypts a personal identity number - every current
 * holder's in the association, onto one file.
 *
 * Three capabilities, and each says something the others do not.
 * `apartmentRegister:read` because the content is that register's;
 * `protectedData:reveal` because the file carries a number the product otherwise
 * masks, so that this cannot become a weaker path to a disclosure the register's
 * own reveal route refuses; and `registerReport:export` because supplying the
 * register onward to a state authority is a different act from reading it. All
 * three are board and administrator today, so no live request tells them apart -
 * which is why the declaration is asserted in register-report.controller.spec.ts
 * rather than left to a request test that would pass without it.
 *
 * A POST although it reads, for the two reasons the register's reveal route
 * gives: it writes an audit entry, and the response carries personal identity
 * numbers that must not sit in a URL, a proxy log or a browser history. A GET
 * would also be a disclosure a browser could take on its own - a prefetch, a
 * bookmark, a link checker - and an audited disclosure has to be an act somebody
 * chose to take.
 */
@Controller("api/register-reports/initial-supply")
@RequireCapability(
  "apartmentRegister:read",
  "protectedData:reveal",
  "registerReport:export",
)
export class InitialSupplyController {
  constructor(private readonly supply: InitialSupplyService) {}

  @Post()
  @HttpCode(200)
  async produce(@Req() request: RequestWithPrincipal): Promise<InitialSupply> {
    return this.supply.produce({ actorPersonId: actingPersonId(request) });
  }
}
