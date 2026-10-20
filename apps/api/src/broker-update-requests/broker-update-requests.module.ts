import { Module } from "@nestjs/common";

import { BrokerUpdateRequestController } from "./broker-update-request.controller";
import { BrokerUpdateRequestPurgeService } from "./broker-update-request-purge.service";
import { BrokerUpdateRequestService } from "./broker-update-request.service";

/**
 * Brokers' requests for the board to look at its facts again, from the form on
 * the broker information page to the board's queue and the purge.
 *
 * The service is exported because the form is rendered and submitted by the
 * public website, in process, the way the contact form is. The confirmation
 * hook that answers open requests is registered from the site module, which
 * owns the facts: this module reads the facts' lock and their current state
 * through plain functions, and imports no module of the website's, so the two
 * do not depend on each other in a circle.
 *
 * Lives outside src/site because it encrypts what the broker typed, and the
 * website may not reach the encryption layer (site-boundary.spec.ts). The
 * database, the field encryption, the audit log and the job queue come from
 * global modules.
 */
@Module({
  controllers: [BrokerUpdateRequestController],
  providers: [BrokerUpdateRequestService, BrokerUpdateRequestPurgeService],
  exports: [BrokerUpdateRequestService],
})
export class BrokerUpdateRequestsModule {}
