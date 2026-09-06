import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import type { SubletApplicationStatus } from "../generated/prisma/enums";
import {
  type OwnSubletApplicationView,
  type QueuedSubletApplicationView,
  type SubletIntakeView,
  type SubletQueueView,
  SubletService,
} from "./sublet.service";

/**
 * The statuses the queue filter accepts.
 *
 * Written out rather than derived from the generated enum, as every controller
 * in this codebase writes its own: this is the wire contract, and a status added
 * to the table is a decision about the API rather than an automatic widening of
 * it. `satisfies` is what keeps the two from drifting apart silently in the other
 * direction - a status renamed or removed in the schema stops compiling here.
 */
const STATUSES = [
  "SUBMITTED",
  "CONSENTED",
  "REFUSED",
  "WITHDRAWN",
] as const satisfies readonly SubletApplicationStatus[];

/** "YYYY-MM-DD". The service checks that the date is one the calendar has. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * What the applicant may still change while the board has not answered.
 *
 * The period and the reason, and deliberately not the apartment: an application
 * about a different flat is a different request, and the service says why.
 */
const revisionSchema = z.object({
  periodFrom: day,
  periodTo: day,
  /**
   * Bounded but generous. The reason is what BRL 7 kap. 11 § weighs if the board
   * refuses - "om bostadsrattshavaren har skal for upplatelsen" - so a cap short
   * enough to truncate somebody's circumstances would truncate the half of the
   * record the tribunal reads.
   */
  reason: z.string().trim().min(1).max(4000),
});

const applicationSchema = revisionSchema.extend({
  apartmentId: z.string().min(1),
});

/**
 * The board's answer.
 *
 * One body with a boolean rather than two routes, because BRL 7 kap. 10 § makes
 * it one decision: the board either gives its samtycke or it does not, and a
 * pair of endpoints would suggest two different acts.
 */
const decisionSchema = z.object({
  consent: z.boolean(),
  note: z.string().trim().min(1).max(2000).nullable(),
});

/**
 * What the rent tribunal (hyresnamnden) decided, or that the record is cleared.
 *
 * Nullable rather than a second route, because it is one answer somebody gives
 * and can take back when it was entered wrongly.
 */
const tribunalSchema = z.object({
  permission: z
    .object({ permittedOn: day, permittedUntil: day.nullable() })
    .nullable(),
});

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches one to every route that is not @Public(), so
 * reaching this throw means the guard stopped doing that - and a 500 naming the
 * guard is the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/**
 * A member asking the board's consent to let in andra hand, and reading their
 * own applications.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. There is deliberately no @Public() route
 * in this module: BRL 7 kap. 10 § gives the act to a bostadsrattshavare, and one
 * is somebody with an account on this instance and a tenant-ownership in its
 * register.
 *
 * `sublets:apply` is derived from membership, like `motions:submit` - see
 * `authorization/capabilities.ts`. The service asks the register again about the
 * apartment named in the request before it writes, which is what keeps an
 * administrator's blanket grant from becoming an application to let somebody
 * else's flat; the capability decides who reaches the form.
 */
@Controller("api/sublet-applications")
@RequireCapability("sublets:apply")
export class SubletIntakeController {
  constructor(private readonly sublets: SubletService) {}

  /**
   * The member's own applications, and the apartments they may apply about.
   *
   * One answer rather than two calls, because the form is unusable without both
   * and because the apartment list is the only one this module discloses: it is
   * the caller's own homes and never the register.
   */
  @Get("mine")
  async listOwn(
    @Req() request: RequestWithPrincipal,
  ): Promise<SubletIntakeView> {
    return this.sublets.intake(requirePrincipal(request).personId);
  }

  @Post()
  @HttpCode(201)
  async apply(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    return this.sublets.apply(
      requirePrincipal(request),
      applicationSchema.parse(body),
    );
  }

  /**
   * Changes what one's own application asks for, while it is still open.
   *
   * A put rather than a post to a named sub-resource, because it replaces what
   * the request says rather than recording that something happened. Every edit
   * goes through the same personal identity number scan the first submission
   * did.
   */
  @Put(":id")
  async revise(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnSubletApplicationView> {
    return this.sublets.revise(
      requirePrincipal(request).personId,
      id,
      revisionSchema.parse(body),
    );
  }

  /**
   * Takes one's own application back, while the board has not answered.
   *
   * A post rather than a delete: the row stays and takes a date and a status, so
   * the member can still point at having asked. Nothing in this module deletes
   * an application except the purge.
   */
  @Post(":id/withdrawal")
  async withdraw(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnSubletApplicationView> {
    return this.sublets.withdraw(requirePrincipal(request).personId, id);
  }
}

/**
 * The queue the board works.
 *
 * Its own base path rather than a route under the intake controller, because the
 * capability covers the whole class: one @RequireCapability("sublets:apply") and
 * one @RequireCapability("sublets:handle") on the same controller would be a
 * route open to the wrong half of the house. It is the split the issues and
 * motions modules make for the same reason.
 *
 * The board's, because BRL 7 kap. 10 § names it: the consent is the styrelse's
 * to give.
 */
@Controller("api/sublet-queue")
@RequireCapability("sublets:handle")
export class SubletQueueController {
  constructor(private readonly sublets: SubletService) {}

  @Get()
  async list(@Query("status") status?: string): Promise<SubletQueueView> {
    const filter = z.enum(STATUSES).optional().parse(status);
    return this.sublets.queue({ status: filter });
  }

  /**
   * Records the board's consent, or its refusal, with the date it was given.
   *
   * A post to a named sub-resource, because it is an event that happened rather
   * than an answer that can be changed: BRL 7 kap. 10 § has the board give or
   * withhold its samtycke once, and a member who was told the association
   * consented has arranged a letting on the strength of it. What comes after a
   * refusal is 11 §, which is the tribunal route below and not a second decision
   * here.
   */
  @Post(":id/decision")
  async decide(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedSubletApplicationView> {
    return this.sublets.decide(
      id,
      requirePrincipal(request).personId,
      decisionSchema.parse(body),
    );
  }

  /**
   * Records what the rent tribunal permitted after a refusal, or clears that
   * record.
   *
   * A put rather than a post, because it is one answer somebody wrote down and
   * can correct - unlike the board's own decision above, which is an act the
   * association took. The service refuses it against anything but a refused
   * application, which is the condition BRL 7 kap. 11 § opens the route on.
   *
   * On the board's controller because the board is the association's side of
   * that proceeding and receives the decision, not because the permission is the
   * board's to give: it is the tribunal's, and recording it changes no status
   * here.
   */
  @Put(":id/tribunal-permission")
  async recordTribunalPermission(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedSubletApplicationView> {
    return this.sublets.recordTribunalPermission(
      id,
      requirePrincipal(request).personId,
      tribunalSchema.parse(body).permission,
    );
  }
}
