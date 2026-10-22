import { Module } from "@nestjs/common";

import { RegisterCheckService } from "./register-check.service";
import {
  WithheldBookableResourcesController,
  WithheldEventsController,
  WithheldMeetingsController,
  WithheldNewsController,
} from "./withheld-from-devices.controller";
import { WithheldFromDevicesService } from "./withheld-from-devices.service";

/**
 * The register check of ADR 0032: whether published text names somebody the
 * register holds, or an apartment, and so stays off every device.
 *
 * Not global. The plugin system imports it for the content it hands a plugin
 * with a device route, and its own routes answer the board's news, events,
 * meetings and bookings editors with the items it withholds and why. A
 * plugin's own module cannot ask the root injector for it, so no plugin can
 * use it to test words against the register.
 */
@Module({
  controllers: [
    WithheldNewsController,
    WithheldEventsController,
    WithheldMeetingsController,
    WithheldBookableResourcesController,
  ],
  providers: [RegisterCheckService, WithheldFromDevicesService],
  exports: [RegisterCheckService],
})
export class RegisterCheckModule {}
