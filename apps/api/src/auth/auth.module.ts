import { Global, Module } from "@nestjs/common";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/**
 * Authentication is needed by every guard, so the service is global while the
 * controller only mounts the Better Auth routes.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
