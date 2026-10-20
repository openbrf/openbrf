import { Global, Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { BearerPrincipalService } from "../auth/bearer-principal.service";
import { SupportRequestInterceptor } from "../support/support-request.interceptor";
import { SupportModule } from "../support/support.module";
import { AuthorizationGuard } from "./authorization.guard";
import { MeController } from "./me.controller";
import { PrincipalService } from "./principal.service";

/**
 * Registers authorization as a global guard so protection is the default and
 * exposure is the explicit choice (see the Public decorator).
 *
 * The bearer resolver is provided here rather than in the sign-in module
 * because the guard is constructed in this injector: this is the only place it
 * would resolve from. SupportModule is imported for the support session's
 * cookie, which the guard resolves before any other credential (ADR 0028),
 * and the interceptor beside the guard serves a support session's request
 * inside the storage the audit log reads its channel from.
 */
@Global()
@Module({
  imports: [SupportModule],
  controllers: [MeController],
  providers: [
    PrincipalService,
    BearerPrincipalService,
    AuthorizationGuard,
    { provide: APP_GUARD, useExisting: AuthorizationGuard },
    { provide: APP_INTERCEPTOR, useClass: SupportRequestInterceptor },
  ],
  exports: [PrincipalService, AuthorizationGuard],
})
export class AuthorizationModule {}
