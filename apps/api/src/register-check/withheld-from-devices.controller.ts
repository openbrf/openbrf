import { Controller, Get, Query } from "@nestjs/common";

import { ClosedToSupport } from "../authorization/closed-to-support.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  withheldIdsSchema,
  type WithheldItem,
  WithheldFromDevicesService,
} from "./withheld-from-devices.service";

/**
 * Which of the items an editor shows the register check withholds from
 * devices, and the words that caused it (ADR 0032).
 *
 * One controller per editor, each under the capability that editor's own
 * screen needs, because a capability covers a whole class. They answer a
 * session and nothing else: none is an action, so no connected app reads which
 * words of the association's text are names in its register. And each is
 * closed to a support session (ADR 0028): what it answers is a fact about who
 * the register holds, protected personal data included, if only as the
 * absence of a word.
 *
 * Every route takes `?ids=` with the ids the editor shows and answers
 * `{ items }`, the withheld ones among them; an id that is not an item's of
 * that kind is not among them.
 */

@Controller("api/withheld-from-devices/news")
@RequireCapability("site:manage")
@ClosedToSupport()
export class WithheldNewsController {
  constructor(private readonly withheld: WithheldFromDevicesService) {}

  @Get()
  async list(@Query("ids") ids?: string): Promise<{ items: WithheldItem[] }> {
    return { items: await this.withheld.news(withheldIdsSchema.parse(ids)) };
  }
}

@Controller("api/withheld-from-devices/events")
@RequireCapability("events:manage")
@ClosedToSupport()
export class WithheldEventsController {
  constructor(private readonly withheld: WithheldFromDevicesService) {}

  @Get()
  async list(@Query("ids") ids?: string): Promise<{ items: WithheldItem[] }> {
    return {
      items: await this.withheld.events(withheldIdsSchema.parse(ids)),
    };
  }
}

@Controller("api/withheld-from-devices/meetings")
@RequireCapability("meetings:manage")
@ClosedToSupport()
export class WithheldMeetingsController {
  constructor(private readonly withheld: WithheldFromDevicesService) {}

  @Get()
  async list(@Query("ids") ids?: string): Promise<{ items: WithheldItem[] }> {
    return {
      items: await this.withheld.meetings(withheldIdsSchema.parse(ids)),
    };
  }
}

@Controller("api/withheld-from-devices/bookable-resources")
@RequireCapability("bookings:configure")
@ClosedToSupport()
export class WithheldBookableResourcesController {
  constructor(private readonly withheld: WithheldFromDevicesService) {}

  @Get()
  async list(@Query("ids") ids?: string): Promise<{ items: WithheldItem[] }> {
    return {
      items: await this.withheld.bookableResources(
        withheldIdsSchema.parse(ids),
      ),
    };
  }
}
