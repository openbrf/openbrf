import { Module } from "@nestjs/common";

import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { ConfigModule } from "./config/config.module";
import { CryptoModule } from "./crypto/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { I18nModule } from "./i18n/i18n.module";
import { JobsModule } from "./jobs/jobs.module";
import { MailModule } from "./mail/mail.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    I18nModule,
    JobsModule,
    MailModule,
    AuthModule,
    AuthorizationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
