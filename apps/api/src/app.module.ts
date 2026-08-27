import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module";
import { CryptoModule } from "./crypto/crypto.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [ConfigModule, CryptoModule],
  controllers: [HealthController],
})
export class AppModule {}
