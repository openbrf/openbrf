import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import type { MotionStatus } from "../generated/prisma/enums";
import {
  type MotionIntakeView,
  type MotionQueueView,
  MotionService,
  type OwnMotionView,
  type QueuedMotionView,
} from "./motion.service";

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
  "ACKNOWLEDGED",
  "WITHDRAWN",
] as const satisfies readonly MotionStatus[];

const submitSchema = z.object({
  /**
   * The one line the notice for the meeting will carry. Bounded to a line: a
   * title longer than this is a body that has been put in the wrong field.
   */
  title: z.string().trim().min(1).max(200),
  /**
   * Bounded but generous. A motion argues for something - the background, the
   * proposal, what it would cost - and a cap short enough to truncate one would
   * push the argument into a second motion.
   */
  body: z.string().trim().min(1).max(8000),
});

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches one to every route that is not @Public(), so reaching
 * this throw means the guard stopped doing that - and a 500 naming the guard is
 * the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/**
 * A member putting an item to the general meeting, and reading their own.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. There is deliberately no @Public() route in
 * this module: EFL 6 kap. 15 § gives the right to a member, and a member is
 * somebody with an account on this instance and a residency in its register.
 *
 * `motions:submit` is the platform's only capability derived from membership
 * rather than from residency, a board seat or a grant - see
 * `authorization/capabilities.ts`. The service asks the register again before it
 * writes, which is what keeps an administrator's blanket grant from becoming a
 * statutory right; the capability decides who reaches the form.
 */
@Controller("api/motions")
@RequireCapability("motions:submit")
export class MotionIntakeController {
  constructor(private readonly motions: MotionService) {}

  /**
   * The member's own motions, and the deadline the bylaws set for them.
   *
   * One answer rather than two calls, because the form is unusable without both:
   * a member writing a motion in January needs to know whether they are inside
   * the association's own deadline, and that answer is part of the intake rather
   * than a setting the screen has to go and look up.
   */
  @Get("mine")
  async listOwn(
    @Req() request: RequestWithPrincipal,
  ): Promise<MotionIntakeView> {
    return this.motions.intake(requirePrincipal(request).personId);
  }

  @Post()
  @HttpCode(201)
  async submit(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    return this.motions.submit(
      requirePrincipal(request),
      submitSchema.parse(body),
    );
  }

  /**
   * Withdraws one's own motion, while it is still open.
   *
   * A post rather than a delete: the row stays and takes a date and a status, so
   * the member can still point at having submitted it. Nothing in this module
   * deletes a motion except the purge.
   */
  @Post(":id/withdrawal")
  async withdraw(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnMotionView> {
    return this.motions.withdraw(requirePrincipal(request).personId, id);
  }
}

/**
 * The queue the board works.
 *
 * Its own base path rather than a route under the intake controller, because the
 * capability covers the whole class: one @RequireCapability("motions:submit") and
 * one @RequireCapability("motions:handle") on the same controller would be a
 * route open to the wrong half of the house. It is the split the issues module
 * makes for the same reason.
 *
 * The board's, because a motion is addressed to it: EFL 6 kap. 15 § has the member
 * ask the board in writing, and it is the board that decides what goes into the
 * notice for the meeting.
 */
@Controller("api/motion-queue")
@RequireCapability("motions:handle")
export class MotionQueueController {
  constructor(private readonly motions: MotionService) {}

  @Get()
  async list(@Query("status") status?: string): Promise<MotionQueueView> {
    const filter = z.enum(STATUSES).optional().parse(status);
    return this.motions.queue({ status: filter });
  }

  /**
   * Records that the board has received a motion and will put it to a meeting.
   *
   * Not an approval, and named for what it is. Whether the meeting adopts the
   * proposal is the meeting's decision and is minuted there; there is deliberately
   * no route on this controller that rejects a motion, because refusing to take up
   * a member's item is not the board's to decide under EFL 6 kap. 15 §.
   */
  @Post(":id/acknowledgement")
  async acknowledge(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedMotionView> {
    return this.motions.acknowledge(id, requirePrincipal(request).personId);
  }
}
