import { Global, Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service";

/**
 * Database access is needed by nearly every feature module, so the client is
 * provided globally rather than imported repeatedly.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
