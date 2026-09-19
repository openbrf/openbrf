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
import {
  type FeeNoticeExport,
  FeeNotificationService,
  type FeeNotificationSummary,
} from "./fee-notification.service";
import {
  FEE_KINDS,
  type FeeRegister,
  type FeeRow,
  FeeService,
} from "./fee.service";

/** ISO calendar date. A fee is dated by the board, never guessed from prose. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/**
 * Kronor and ore.
 *
 * The same shape the charge, the lien note and the transfer price take, so
 * every decimal field in this product is entered the same way. Twelve digits is
 * far above anything a housing cooperative charges a household in a month, and
 * the point of the bound is the column rather than the plausibility:
 * `DECIMAL(14, 2)` is what the table holds, and a request the schema let
 * through would fail in the driver with nothing a screen could say.
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
 * be refused by the platform rather than by the law. The same bound the charges
 * controller states, for the same reason.
 */
const vatRatePercent = z.coerce.number().int().min(1).max(100);

const feeSchema = z.object({
  apartmentId: z.string().min(1),
  kind: z.enum(FEE_KINDS),
  appliesFrom: isoDate,
  monthlyAmount: amount,
  vatTreatment: z.enum(VAT_TREATMENTS),
  vatRatePercent: vatRatePercent.nullish(),
});

const registerQuerySchema = z.object({
  /** The day the rates are read as in force on. */
  on: isoDate,
});

const notificationSchema = z.object({
  from: isoDate,
  to: isoDate,
  dueOn: isoDate,
});

/**
 * The fees the apartments pay (avgifter).
 *
 * One capability, declared on the class so a route added here later inherits it
 * rather than being open by omission. There is no resident-facing half and no
 * second controller: a member learns what they owe from the notice the board
 * produces, and what they are entitled to see of what is stored is on their
 * data subject access report, which is a different route with a different gate.
 *
 * Recording a rate is a POST to a collection and removing one is a DELETE.
 * There is no route that edits a rate: a rate is superseded by recording the
 * next one, which closes it, and one recorded in error is removed. That is the
 * shape the charges module gives the charged party, and here it is the shape of
 * the whole row.
 */
@Controller("api/fees")
@RequireCapability("fees:manage")
export class FeesController {
  constructor(private readonly fees: FeeService) {}

  /** The fee register as it stands on a day. */
  @Get()
  async register(@Query() query: unknown): Promise<FeeRegister> {
    const { on } = registerQuerySchema.parse(query);
    return this.fees.readRegister(on);
  }

  /**
   * Records one rate, closing the one it replaces.
   *
   * Answers with the row as the register would show it, so a screen that has
   * just recorded a rate shows the same figures as the register it sits on
   * rather than a second rendering of them.
   */
  @Post()
  @HttpCode(201)
  async record(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<FeeRow> {
    const input = feeSchema.parse(body);
    return this.fees.record({
      actorPersonId: actingPersonId(request),
      apartmentId: input.apartmentId,
      kind: input.kind,
      appliesFrom: input.appliesFrom,
      monthlyAmount: input.monthlyAmount,
      vatTreatment: input.vatTreatment,
      vatRatePercent: input.vatRatePercent ?? null,
    });
  }

  /** Removes one rate recorded in error. */
  @Delete(":feeId")
  @HttpCode(204)
  async remove(
    @Param("feeId") feeId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.fees.remove(feeId, actingPersonId(request));
  }
}

/**
 * Issuing a period's notices, and producing the document (avisering).
 *
 * A second controller rather than more routes on the one above, because the
 * path is what says which of the two things a request is about: a rate standing
 * against an apartment, or a run that billed a period. One capability across
 * both, for the reason `capabilities.ts` gives - a board that records a rate
 * does so in order to bill it.
 *
 * Producing the document is a POST while the list is a GET, and that difference
 * is the point. Reading the runs is the board working in its own instance;
 * producing the document is a copy of named apartments' amounts leaving the
 * association, it writes an audit entry, and an audited disclosure has to be an
 * act somebody chose to take rather than something a prefetch, a bookmark or a
 * link checker could cause. The debiting list export and the register supply
 * route make the same choice for the same reason.
 *
 * There is no route that changes a run. A run and its notices are
 * rakenskapsinformation and bokforingslagen 7 kap. 1 § forbids altering what is
 * preserved; the purge is the only thing that reaches them.
 */
@Controller("api/fee-notifications")
@RequireCapability("fees:manage")
export class FeeNotificationsController {
  constructor(private readonly notifications: FeeNotificationService) {}

  /** The runs the board has made, newest period first. */
  @Get()
  async list(): Promise<FeeNotificationSummary[]> {
    return this.notifications.list();
  }

  /** Issues the period's notices. */
  @Post()
  @HttpCode(201)
  async issue(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<FeeNotificationSummary> {
    const input = notificationSchema.parse(body);
    return this.notifications.issue({
      actorPersonId: actingPersonId(request),
      from: input.from,
      to: input.to,
      dueOn: input.dueOn,
    });
  }

  /** Produces one run's document, and records that it was produced. */
  @Post(":notificationId/document")
  @HttpCode(200)
  async produce(
    @Param("notificationId") notificationId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<FeeNoticeExport> {
    return this.notifications.produce({
      actorPersonId: actingPersonId(request),
      notificationId,
    });
  }
}
