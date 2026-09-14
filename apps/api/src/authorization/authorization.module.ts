import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { BearerPrincipalService } from "../auth/bearer-principal.service";
import { AuthorizationGuard } from "./authorization.guard";
import { MeController } from "./me.controller";
import { PrincipalService } from "./principal.service";

/**
 * Registers authorization as a global guard so protection is the default and
 * exposure is the explicit choice (see the Public decorator).
 *
 * The bearer resolver is provided here rather than in the sign-in module
 * because the guard is constructed in this injector, which imports nothing:
 * this is the only place it would resolve from.
 */
@Global()
@Module({
  controllers: [MeController],
  providers: [
    PrincipalService,
    BearerPrincipalService,
    AuthorizationGuard,
    { provide: APP_GUARD, useExisting: AuthorizationGuard },
  ],
  exports: [PrincipalService, AuthorizationGuard],
})
export class AuthorizationModule {}
