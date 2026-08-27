import { Module } from "@nestjs/common";

import { AuditModule } from "./audit/audit.module";
import { ConfigModule } from "./config/config.module";
import { CryptoModule } from "./crypto/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { I18nModule } from "./i18n/i18n.module";
import { MailModule } from "./mail/mail.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    I18nModule,
    MailModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
