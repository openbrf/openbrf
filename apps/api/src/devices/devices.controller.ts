import { Controller, Delete, Get, Param, Req } from "@nestjs/common";

import { webActor } from "../audit/actor-context";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { DeviceTokenNotFoundError } from "./device-token.errors";
import {
  DeviceTokenService,
  type LiveDeviceToken,
} from "./device-token.service";

/**
 * The board's devices screen: every live device token on the instance, and
 * revoking one (ADR 0031).
 *
 * Under `site:manage`, the capability a token is issued under: the board
 * issues the tokens, so the board has to be able to cut them, and doing so
 * never depends on the plugin's own screen being right.
 */
@Controller("api/devices")
export class DevicesController {
  constructor(private readonly devices: DeviceTokenService) {}

  @Get()
  @RequireCapability("site:manage")
  async live(): Promise<{ devices: LiveDeviceToken[] }> {
    return { devices: await this.devices.listLive() };
  }

  /** Revokes a live token. The next call the device makes is refused. */
  @Delete(":id")
  @RequireCapability("site:manage")
  async revoke(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
  ): Promise<{ revoked: true }> {
    const revoked = await this.devices.revokeForBoard(
      id,
      webActor(request).personId,
    );
    // Already revoked reads as not found: the screen lists live tokens only,
    // so a second press, or one from a stale list, has nothing to cut.
    if (!revoked) {
      throw new DeviceTokenNotFoundError();
    }
    return { revoked: true };
  }
}
