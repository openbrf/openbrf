import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";
import { z } from "zod";

import { webActor } from "../audit/actor-context";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { PrismaService } from "../database/prisma.service";
import { DEVICE_LABEL_MAX_LENGTH } from "../devices/device-token";
import { DeviceTokenService } from "../devices/device-token.service";
import { PluginBookingsService } from "../plugins/plugin-bookings.service";

const issueSchema = z.object({
  // Checked again, trimmed, by the token service, whose refusal the screen
  // translates; this bound only keeps an absurd body out.
  label: z.string().max(DEVICE_LABEL_MAX_LENGTH * 4),
});

/** What the display screen offers the board to compose a link from. */
export interface DisplayLinkOptions {
  /**
   * The bookable resources a screen could show, by name, in the order the
   * display mode shows them by default. Those the register check withholds
   * from devices are not offered: no screen would show them.
   */
  resources: { id: string; name: string }[];
  /** The instance's default language, which a link without one shows. */
  defaultLocale: "sv" | "en";
}

/**
 * The board's display screen: issuing a display link's token (ADR 0050).
 *
 * Under `site:manage`, the capability every device token is issued under: a
 * screen in the building shows what the association publishes, and deciding
 * what is published is the board's. The screen composes the link from the
 * board's choices in the browser and keeps none of them; the instance keeps
 * only the token's row, which the devices screen lists under "Display mode"
 * and any board member there may revoke.
 *
 * Not under `/api/display`, which is the display route and answers to a
 * device token and to nothing else.
 */
@Controller("api/display-links")
@RequireCapability("site:manage")
export class DisplayLinksController {
  constructor(
    private readonly devices: DeviceTokenService,
    private readonly bookings: PluginBookingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("options")
  async options(): Promise<DisplayLinkOptions> {
    const [resources, association] = await Promise.all([
      this.bookings.resources({ forDevices: true }),
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: { defaultLocale: true },
      }),
    ]);
    return {
      resources: resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
      })),
      defaultLocale: association?.defaultLocale === "en" ? "en" : "sv",
    };
  }

  /**
   * Issues a token for the display route. The token is in this answer and in
   * no other: the screen puts it in the link's fragment and shows it once.
   */
  @Post()
  async issue(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ token: string; device: DeviceTokenSummary }> {
    const input = issueSchema.parse(body);
    return await this.devices.issueForDisplay(
      webActor(request).personId,
      input.label,
    );
  }
}
