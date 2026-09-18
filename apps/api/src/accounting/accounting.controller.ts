import { Controller, HttpCode, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import {
  type AccountingBasisExport,
  AccountingBasisService,
} from "./accounting-basis.service";

/** ISO calendar date. A period is stated by the board, never guessed from prose. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const periodSchema = z.object({
  from: isoDate,
  to: isoDate,
});

/**
 * The accounting basis (bokforingsunderlag): the period's fee notices and
 * member charges, in the file whoever keeps the association's books reads.
 *
 * ## Both capabilities, and that is the point
 *
 * The file carries both halves of the association's money, so producing it
 * needs the seat that manages each. They are two capabilities because they are
 * two acts under different parts of the statute - fixing the avgifter is the
 * board's standing task under BRL 9 kap. 13 §, while a debitering records that
 * something happened once - and a cooperative that has given its treasurer the
 * fee book while the whole board approves individual charges is a split this
 * product can express. A seat holding one of them may take that half's own
 * document and not this file: the capabilities are combined with AND for
 * exactly that reason, and widening either would otherwise quietly widen this.
 *
 * ## One route, and it is a POST
 *
 * There is no read half here, unlike the debiting list and the notice document,
 * which the board reads on screen while it works. Every row in this file is a
 * copy of named apartments' and named people's money leaving the association
 * for a recipient outside it; it writes an audit entry, and an audited
 * disclosure has to be an act somebody chose to take rather than something a
 * prefetch, a bookmark or a link checker could cause. The debiting list export
 * and the register supply route make the same choice for the same reason.
 *
 * The period travels in the query rather than in a body, so this export and the
 * debiting list's are asked the same question in the same words; what makes it
 * a POST is the disclosure, not the shape of the request.
 */
@Controller("api/accounting-basis")
@RequireCapability("fees:manage", "memberCharges:manage")
export class AccountingController {
  constructor(private readonly basis: AccountingBasisService) {}

  /** Produces the period's basis, and records that it was produced. */
  @Post("export")
  @HttpCode(200)
  async export(
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<AccountingBasisExport> {
    const period = periodSchema.parse(query);
    return this.basis.produce({
      actorPersonId: actingPersonId(request),
      from: period.from,
      to: period.to,
    });
  }
}
