import { Controller, Delete, Get, HttpCode, Param, Req } from "@nestjs/common";

import { webActor } from "../audit/actor-context";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type BrokerUpdateRequestQueue,
  BrokerUpdateRequestService,
} from "./broker-update-request.service";

/**
 * The board's queue of brokers' update requests.
 *
 * Gated on site:manage, the capability that records and confirms the facts
 * these requests are about: whoever can answer a request by confirming the
 * facts is whoever reads it. There is no action to answer one here, because
 * the answer is the confirmation on the facts screen, and a second way to
 * close a request without looking at the facts would be a way to empty the
 * queue that tells the broker nothing true.
 *
 * The form that fills the queue is public and lives on the website's forms
 * controller, for the reason the contact inbox gives: one @Public() and one
 * @RequireCapability() on the same class is the mistake that opens a route
 * rather than closing it.
 */
@Controller("api/broker-update-requests")
@RequireCapability("site:manage")
export class BrokerUpdateRequestController {
  constructor(private readonly requests: BrokerUpdateRequestService) {}

  @Get()
  async list(): Promise<BrokerUpdateRequestQueue> {
    return this.requests.list();
  }

  /** Dismisses a request, which deletes it. */
  @Delete(":id")
  @HttpCode(204)
  async dismiss(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
  ): Promise<void> {
    await this.requests.dismiss(id, webActor(request));
  }
}
