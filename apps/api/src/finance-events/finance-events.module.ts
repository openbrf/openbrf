import { Module } from "@nestjs/common";

import { FinanceEventsService } from "./finance-events.service";

/**
 * Finance events for plugins.
 *
 * Its own module, imported by the fees and charges modules that publish and by
 * the plugin system that listens, so neither side imports the other. Not
 * global: a plugin's module could otherwise resolve the service by type from
 * the root injector and listen on another plugin's queue.
 */
@Module({
  providers: [FinanceEventsService],
  exports: [FinanceEventsService],
})
export class FinanceEventsModule {}
