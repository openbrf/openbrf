import { Module } from "@nestjs/common";

import { ActionsModule } from "../actions/actions.module";
import { PendingChangeService } from "./pending-change.service";
import { PendingChangesController } from "./pending-changes.controller";

/**
 * The pending-change queue (ADR 0039): a call to an action
 * held as a preview until the person who proposed it confirms or rejects it on
 * the platform's own screen.
 *
 * Imports ActionsModule, because proposing is checked by the registry and
 * confirming dispatches through it. Deliberately not global, for the reason the
 * registry is not: a plugin reaches proposing only through
 * `host.actions.propose`, which carries the request its own route received,
 * and has no way to hold the service and confirm. The expiry sweep rides the
 * service-data purge (`retention/pending-change-sweep.ts`) rather than a job
 * here.
 */
@Module({
  imports: [ActionsModule],
  controllers: [PendingChangesController],
  providers: [PendingChangeService],
  exports: [PendingChangeService],
})
export class PendingChangesModule {}
