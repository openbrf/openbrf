import { Module } from "@nestjs/common";

import { DevicesController } from "./devices.controller";
import { DeviceTokenService } from "./device-token.service";

/**
 * Device tokens for plugins' device routes: issuing them for a plugin's
 * `host.devices`, and the board's devices screen that lists and revokes every
 * live one (ADR 0031).
 *
 * Not global. The plugin system imports it to hand a plugin its narrowed
 * `host.devices`, and the authorization guard reads tokens through a resolver
 * of its own (`DeviceTokenResolver`) rather than through this, so nothing a
 * plugin's module can ask the root injector for issues or revokes a token.
 */
@Module({
  controllers: [DevicesController],
  providers: [DeviceTokenService],
  exports: [DeviceTokenService],
})
export class DevicesModule {}
