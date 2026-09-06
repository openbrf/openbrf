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
import type { KeyOrderKind, KeyOrderStatus } from "../generated/prisma/enums";
import {
  type KeyOrderIntakeView,
  type KeyOrderQueueView,
  KeyOrderService,
  type OwnKeyOrderView,
  type QueuedKeyOrderView,
} from "./key-order.service";

/**
 * The kinds and statuses the wire accepts.
 *
 * Written out rather than derived from the generated enums, as every controller
 * in this codebase writes its own: this is the wire contract, and a value added
 * to the table is a decision about the API rather than an automatic widening of
 * it. `satisfies` is what keeps the two from drifting apart silently in the other
 * direction - a value renamed or removed in the schema stops compiling here.
 */
const KINDS = ["KEY", "TAG"] as const satisfies readonly KeyOrderKind[];

const STATUSES = [
  "SUBMITTED",
  "HANDED_OVER",
  "DECLINED",
  "WITHDRAWN",
] as const satisfies readonly KeyOrderStatus[];

/**
 * What the resident may still change while the board has not answered.
 *
 * The kind, the quantity and the note, and deliberately not the apartment: an
 * order for a different door is a different order, and the service says why.
 */
const revisionSchema = z.object({
  kind: z.enum(KINDS),
  /**
   * Bounded to what a household plausibly wants, and the database says the same
   * thing in a check constraint. A four-figure quantity is a typed mistake the
   * board would otherwise have to catch by reading.
   */
  quantity: z.number().int().min(1).max(10),
  /**
   * Which door, or what it is for. Nullable, because a tag for the entrance
   * needs no explanation and a field that insisted on one would collect a line
   * of nothing.
   */
  note: z.string().trim().min(1).max(1000).nullable(),
});

const orderSchema = revisionSchema.extend({
  apartmentId: z.string().min(1),
});

/**
 * The board's answer.
 *
 * One body with a boolean rather than two routes, because it is one act with two
 * outcomes: the key was handed over, or the order was declined. A pair of
 * endpoints would suggest two different decisions.
 */
const answerSchema = z.object({
  handedOver: z.boolean(),
  note: z.string().trim().min(1).max(1000).nullable(),
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
 * A resident ordering a key or a tag, and reading their own orders.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. There is deliberately no @Public() route
 * in this module: a key to the building is not something a visitor asks for.
 *
 * `keyOrders:place` is derived from residency, like `bookings:book` - see
 * `authorization/capabilities.ts`. The service asks the register again about the
 * apartment named in the request before it writes, which is what keeps an
 * administrator's blanket grant from becoming an order for somebody else's door;
 * the capability decides who reaches the form.
 */
@Controller("api/key-orders")
@RequireCapability("keyOrders:place")
export class KeyOrderIntakeController {
  constructor(private readonly orders: KeyOrderService) {}

  /**
   * The resident's own orders, and the apartments they may order for.
   *
   * One answer rather than two calls, because the form is unusable without both
   * and because the apartment list is the only one this module discloses: it is
   * the caller's own homes and never the register.
   */
  @Get("mine")
  async listOwn(
    @Req() request: RequestWithPrincipal,
  ): Promise<KeyOrderIntakeView> {
    return this.orders.intake(requirePrincipal(request).personId);
  }

  @Post()
  @HttpCode(201)
  async place(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    return this.orders.place(
      requirePrincipal(request),
      orderSchema.parse(body),
    );
  }

  /**
   * Changes a standing order, while the board has not answered.
   *
   * A put rather than a post to a named sub-resource, because it replaces what
   * the order says rather than recording that something happened. Every edit
   * goes through the same personal identity number scan the first order did.
   */
  @Put(":id")
  async revise(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnKeyOrderView> {
    return this.orders.revise(
      requirePrincipal(request).personId,
      id,
      revisionSchema.parse(body),
    );
  }

  /**
   * Takes one's own order back, while the board has not answered.
   *
   * A post rather than a delete: the row stays and takes a date and a status.
   * Nothing in this module deletes an order except the purge.
   */
  @Post(":id/withdrawal")
  async withdraw(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnKeyOrderView> {
    return this.orders.withdraw(requirePrincipal(request).personId, id);
  }
}

/**
 * The queue the board works.
 *
 * Its own base path rather than a route under the intake controller, because the
 * capability covers the whole class: one @RequireCapability("keyOrders:place")
 * and one @RequireCapability("keyOrders:handle") on the same controller would be
 * a route open to the wrong half of the house. It is the split the issues,
 * motions and sublets modules make for the same reason.
 */
@Controller("api/key-order-queue")
@RequireCapability("keyOrders:handle")
export class KeyOrderQueueController {
  constructor(private readonly orders: KeyOrderService) {}

  @Get()
  async list(@Query("status") status?: string): Promise<KeyOrderQueueView> {
    const filter = z.enum(STATUSES).optional().parse(status);
    return this.orders.queue({ status: filter });
  }

  /**
   * Records the handover, or that the board declined the order.
   *
   * A post to a named sub-resource, because it is an event that happened rather
   * than an answer that can be changed: a key that has been handed over is in
   * somebody's pocket, and a record that could be edited back would be a record
   * of nothing. An order answered wrongly is corrected by the resident placing
   * another one, which is what actually happens in a stairwell.
   */
  @Post(":id/answer")
  async answer(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedKeyOrderView> {
    return this.orders.answer(
      id,
      requirePrincipal(request).personId,
      answerSchema.parse(body),
    );
  }
}
