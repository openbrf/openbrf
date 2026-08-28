import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { AddressBookModule } from "./address-book/address-book.module";
import { AddressesModule } from "./addresses/addresses.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { ConfigModule } from "./config/config.module";
import { CryptoModule } from "./crypto/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { DomainExceptionFilter } from "./http/domain-exception.filter";
import { HealthController } from "./health/health.controller";
import { I18nModule } from "./i18n/i18n.module";
import { InvitationsModule } from "./invitations/invitations.module";
import { JobsModule } from "./jobs/jobs.module";
import { MailModule } from "./mail/mail.module";
import { SettingsModule } from "./settings/settings.module";
import { SetupModule } from "./setup/setup.module";
import { SignupModule } from "./signup/signup.module";

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
    InvitationsModule,
    SignupModule,
    SetupModule,
    SettingsModule,
    AddressesModule,
    AddressBookModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
