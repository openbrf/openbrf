import { Module } from "@nestjs/common";

import { DevicesModule } from "../devices/devices.module";
import { MediaModule } from "../media/media.module";
import { PluginBookingsService } from "../plugins/plugin-bookings.service";
import { PluginCalendarService } from "../plugins/plugin-calendar.service";
import { PluginNewsService } from "../plugins/plugin-news.service";
import { RegisterCheckModule } from "../register-check/register-check.module";
import { DisplayContentService } from "./display-content.service";
import { DisplayController } from "./display.controller";
import { DisplayLinksController } from "./display-links.controller";

/**
 * The display mode for screens (ADR 0050): the core's display route, which
 * serves a screen holding a display link its screen content, and the board's
 * display screen, which issues the link's device token.
 *
 * The route reads the published content the board marked "show on screens"
 * through the same narrowed reads a plugin with a device route gets - the
 * content services are provided here as well as in the plugin system, so the
 * route reaches no plugin and no extension point - and builds the rotation
 * with `@openbrf/display`, the builder the signage module uses too. Exports
 * nothing.
 */
@Module({
  imports: [DevicesModule, MediaModule, RegisterCheckModule],
  controllers: [DisplayController, DisplayLinksController],
  providers: [
    DisplayContentService,
    PluginNewsService,
    PluginCalendarService,
    PluginBookingsService,
  ],
})
export class DisplayModule {}
