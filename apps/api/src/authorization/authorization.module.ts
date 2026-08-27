import { Global, Module } from "@nestjs/common";

import { AuthorizationGuard } from "./authorization.guard";
import { PrincipalService } from "./principal.service";

@Global()
@Module({
  providers: [PrincipalService, AuthorizationGuard],
  exports: [PrincipalService, AuthorizationGuard],
})
export class AuthorizationModule {}
