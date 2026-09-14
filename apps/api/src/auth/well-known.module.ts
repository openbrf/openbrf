import { Module } from "@nestjs/common";

import { WellKnownController } from "./well-known.controller";

/**
 * Its own module so that its position in AppModule's imports can be chosen.
 *
 * The controller claims paths at the root of the origin, and the module that
 * serves the association's own website claims every single-segment path no
 * earlier controller declared. This therefore has to be imported ahead of it,
 * or a discovery request would be answered with the website's not-found page:
 * the single-page-app fallback treats only /health and /api as the API's, so
 * an unclaimed /.well-known/... is not recognised as an API path at all.
 */
@Module({
  controllers: [WellKnownController],
})
export class WellKnownModule {}
