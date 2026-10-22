import { Module } from "@nestjs/common";

import { RegisterCheckService } from "./register-check.service";

/**
 * The register check of ADR 0032: whether published text names somebody the
 * register holds, or an apartment, and so stays off every device.
 *
 * Not global. The plugin system imports it for the content it hands a plugin
 * with a device route, and the news, events, meetings and bookings modules
 * import it for the mark their editors show the board. A plugin's own module
 * cannot ask the root injector for it, so no plugin can use it to test words
 * against the register.
 */
@Module({
  providers: [RegisterCheckService],
  exports: [RegisterCheckService],
})
export class RegisterCheckModule {}
