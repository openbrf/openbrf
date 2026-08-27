import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AuthorizationGuard } from "./authorization.guard";
import { PrincipalService } from "./principal.service";

/**
 * Registers authorization as a global guard so protection is the default and
 * exposure is the explicit choice (see the Public decorator).
 */
@Global()
@Module({
  providers: [
    PrincipalService,
    AuthorizationGuard,
    { provide: APP_GUARD, useExisting: AuthorizationGuard },
  ],
  exports: [PrincipalService, AuthorizationGuard],
})
export class AuthorizationModule {}
