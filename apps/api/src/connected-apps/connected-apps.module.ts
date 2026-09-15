import { Module } from "@nestjs/common";

import {
  ConnectedAppsAdminController,
  MyConnectedAppsController,
  OAuthConsentController,
} from "./connected-apps.controller";
import { ConnectedAppsService } from "./connected-apps.service";
import { OAuthClientsController } from "./oauth-clients.controller";

/**
 * Seeing, granting and cutting a member's connected apps.
 *
 * The sign-in library owns the protocol; this owns the questions a member and
 * a board actually have about it - what is connected, who connected it, and
 * cutting one off now.
 */
@Module({
  controllers: [
    MyConnectedAppsController,
    ConnectedAppsAdminController,
    OAuthConsentController,
    OAuthClientsController,
  ],
  providers: [ConnectedAppsService],
  exports: [ConnectedAppsService],
})
export class ConnectedAppsModule {}
