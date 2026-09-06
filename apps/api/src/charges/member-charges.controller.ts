import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import type { DebitingList, DebitingListRow } from "./debiting-list";
import {
  type DebitingListExport,
  MemberChargeService,
} from "./member-charge.service";

/** ISO calendar date. A charge is dated by the board, never guessed from prose. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/**
 * Kronor and ore.
 *
 * The same shape the lien note and the transfer price take, so the three
 * decimal fields in this product are entered the same way. Twelve digits is far
 * above anything a housing cooperative charges a member, and the point of the
 * bound is the column rather than the plausibility: `DECIMAL(14, 2)` is what the
 * table holds, and a request the schema let through would fail in the driver
 * with nothing a screen could say.
 */
const amount = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "must be a decimal amount");

const VAT_TREATMENTS = ["EXEMPT", "RATE"] as const;

/**
 * Bounded but not enumerated.
 *
 * A whole percentage, and which percentages are in force is
 * mervardesskattelagen's question rather than this schema's - they move by
 * amendment, and a board told to apply a rate this file had not heard of would
 * be refused by the platform rather than by the law.
 */
const vatRatePercent = z.coerce.number().int().min(1).max(100);

const chargeSchema = z.object({
  /**
   * Exactly one of the two, decided in the service.
   *
   * Both are nullish here rather than a union of two shapes, so a form that
   * clears one field and fills the other sends null and is read the same way as
   * one that never carried it. Which combinations are a charge is the service's
   * rule, and it answers with a reason code a screen can put a sentence to;
   * a schema refusing it would answer 400 with a path.
   */
  personId: z.string().min(1).nullish(),
  apartmentId: z.string().min(1).nullish(),
  chargedOn: isoDate,
  amount,
  /**
   * Bounded but generous. A reason says what was bought or done and for whom,
   * which is a sentence or two - and it is the sentence the member is shown on
   * their invoice, so it has room to be an explanation rather than a code.
   */
  reason: z.string().trim().min(1).max(500),
  vatTreatment: z.enum(VAT_TREATMENTS),
  vatRatePercent: vatRatePercent.nullish(),
  handedToManagerOn: isoDate.nullish(),
});

/**
 * A correction, with every field optional.
 *
 * The charged party is absent, and its absence is the rule: a charge put on the
 * wrong person is removed and recorded again, so that the log says what
 * happened. See `CorrectMemberChargeInput`.
 *
 * `vatRatePercent` and `handedToManagerOn` are nullish rather than optional, so
 * clearing one is a value the request can carry. A field left out is a field
 * left alone; a field sent as null is a field emptied.
 */
const correctionSchema = z.object({
  chargedOn: isoDate.optional(),
  amount: amount.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  vatTreatment: z.enum(VAT_TREATMENTS).optional(),
  vatRatePercent: vatRatePercent.nullish(),
  handedToManagerOn: isoDate.nullish(),
});

const periodSchema = z.object({
  from: isoDate,
  to: isoDate,
});

/**
 * Charges to members (debiteringar mot medlem), and the debiting list.
 *
 * One capability, declared on the class so a route added here later inherits it
 * rather than being open by omission. There is no resident-facing half and no
 * second controller: a member is told what they are being charged by the notice
 * that reaches them from the accounting system, and what Open BRF holds is the
 * basis. What a member is entitled to see of it is on their data subject access
 * report, which is a different route with a different gate.
 *
 * The export is a POST while the read is a GET, and that difference is the
 * point. Reading the list is the board working in its own instance; producing
 * the file is a copy of named people's charges leaving the association for a
 * bookkeeper outside it, it writes an audit entry, and an audited disclosure has
 * to be an act somebody chose to take rather than something a prefetch, a
 * bookmark or a link checker could cause. The register supply route makes the
 * same choice for the same reason.
 */
@Controller("api/member-charges")
@RequireCapability("memberCharges:manage")
export class MemberChargesController {
  constructor(private readonly charges: MemberChargeService) {}

  /** The debiting list for a period. */
  @Get()
  async list(@Query() query: unknown): Promise<DebitingList> {
    const period = periodSchema.parse(query);
    return this.charges.list(period.from, period.to);
  }

  /**
   * Records one charge.
   *
   * Answers with the row as the list would show it, so a screen that has just
   * recorded a charge shows the same masking, the same apartment and the same
   * figures as the list it sits on rather than a second rendering of them.
   */
  @Post()
  @HttpCode(201)
  async record(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<DebitingListRow> {
    const input = chargeSchema.parse(body);
    return this.charges.record({
      actorPersonId: actingPersonId(request),
      personId: input.personId ?? null,
      apartmentId: input.apartmentId ?? null,
      chargedOn: input.chargedOn,
      amount: input.amount,
      reason: input.reason,
      vatTreatment: input.vatTreatment,
      vatRatePercent: input.vatRatePercent ?? null,
      handedToManagerOn: input.handedToManagerOn ?? null,
    });
  }

  /**
   * Corrects one charge.
   *
   * A POST to a named act rather than a PATCH, which is the shape every other
   * partial write in this product takes. It also says what the request is: a
   * field left out is a field left alone, and a PUT would say the opposite about
   * the same body.
   */
  @Post(":chargeId/correct")
  @HttpCode(200)
  async correct(
    @Param("chargeId") chargeId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<DebitingListRow> {
    const input = correctionSchema.parse(body);
    return this.charges.correct(chargeId, {
      actorPersonId: actingPersonId(request),
      ...input,
    });
  }

  /** Removes one charge. */
  @Delete(":chargeId")
  @HttpCode(204)
  async remove(
    @Param("chargeId") chargeId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.charges.remove(chargeId, actingPersonId(request));
  }

  /**
   * Produces the debiting list as the file the board hands over.
   *
   * The period travels in the query rather than in a body, so the export and
   * the read above are asked the same question in the same words; what makes
   * this a POST is the disclosure, not the shape of the request.
   */
  @Post("export")
  @HttpCode(200)
  async export(
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<DebitingListExport> {
    const period = periodSchema.parse(query);
    return this.charges.exportList({
      actorPersonId: actingPersonId(request),
      from: period.from,
      to: period.to,
    });
  }
}
