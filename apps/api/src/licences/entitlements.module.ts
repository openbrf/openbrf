import { Module } from "@nestjs/common";

import { EntitlementsService } from "./entitlements.service";
import { InstanceIdentityService } from "./instance-identity.service";

/**
 * The instance's identity and the judging of a paid plugin's licence
 * (ADR 0042): the instance id and key a licence is bound to, and what
 * `host.entitlements` answers.
 *
 * Not global, so a plugin cannot resolve either service by type from the root
 * injector and sign with the instance key or read another plugin's licence.
 * PluginsModule imports it to hand each licensed plugin its own view, and
 * LicencesModule for the licence screen.
 */
@Module({
  providers: [InstanceIdentityService, EntitlementsService],
  exports: [InstanceIdentityService, EntitlementsService],
})
export class EntitlementsModule {}
