import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { AddressBookModule } from "./address-book/address-book.module";
import { AddressesModule } from "./addresses/addresses.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { BoardModule } from "./board/board.module";
import { BookingsModule } from "./bookings/bookings.module";
import { ConfigModule } from "./config/config.module";
import { ContactModule } from "./contact/contact.module";
import { CryptoModule } from "./crypto/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { DocumentsModule } from "./documents/documents.module";
import { EventsModule } from "./events/events.module";
import { DomainExceptionFilter } from "./http/domain-exception.filter";
import { HealthController } from "./health/health.controller";
import { I18nModule } from "./i18n/i18n.module";
import { ImportModule } from "./import/import.module";
import { InvitationsModule } from "./invitations/invitations.module";
import { IssuesModule } from "./issues/issues.module";
import { JobsModule } from "./jobs/jobs.module";
import { MailModule } from "./mail/mail.module";
import { MeetingsModule } from "./meetings/meetings.module";
import { SmsModule } from "./sms/sms.module";
import { MediaModule } from "./media/media.module";
import { MotionsModule } from "./motions/motions.module";
import { MovesModule } from "./moves/moves.module";
import { NewsModule } from "./news/news.module";
import { PackagingModule } from "./packaging/packaging.module";
import { PluginsModule } from "./plugins/plugins.module";
import { PublicRateLimitGuard } from "./http/public-rate-limit.guard";
import { RegistersModule } from "./registers/registers.module";
import { RetentionModule } from "./retention/retention.module";
import { RolesModule } from "./roles/roles.module";
import { SettingsModule } from "./settings/settings.module";
import { SetupModule } from "./setup/setup.module";
import { SignupModule } from "./signup/signup.module";
import { SiteModule } from "./site/site.module";
import { StorageModule } from "./storage/storage.module";
import { ThemesModule } from "./themes/themes.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuditModule,
    I18nModule,
    JobsModule,
    StorageModule,
    MediaModule,
    MailModule,
    SmsModule,
    AuthModule,
    AuthorizationModule,
    InvitationsModule,
    SignupModule,
    SetupModule,
    SettingsModule,
    AddressesModule,
    AddressBookModule,
    RegistersModule,
    RolesModule,
    MovesModule,
    ImportModule,
    ThemesModule,
    PackagingModule,
    PluginsModule,
    IssuesModule,
    DocumentsModule,
    RetentionModule,
    ContactModule,
    NewsModule,
    BoardModule,
    BookingsModule,
    EventsModule,
    MotionsModule,
    MeetingsModule,
    // Last: its parameter route claims every single-segment path no earlier
    // controller declared, so anything registering a root path of its own has
    // to be ahead of it.
    SiteModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    /*
     * Global, and inert on every route that declares no budget.
     *
     * The alternative - naming the guard on each controller that wants it -
     * would give each module its own instance and its own buckets, so the same
     * caller would hold a separate budget per module. Registered once here,
     * @PublicRateLimit is the whole of what a public endpoint has to say, and a
     * form added later cannot be limited in one place and not another.
     */
    { provide: APP_GUARD, useClass: PublicRateLimitGuard },
  ],
})
export class AppModule {
  /**
   * The application with the installed plugins' own modules in its graph.
   *
   * A plugin contributes a NestJS module, and NestJS registers controllers
   * only for modules present when the container is built - a module added
   * afterwards can contribute providers and nothing else. So the modules are
   * loaded from the data volume before `NestFactory.create` and imported here
   * (ADR 0003). They come last, after the modules a plugin's own providers may
   * resolve against.
   *
   * Importing AppModule directly is still the plugin-free application, which
   * is what everything that does not need a plugin should use.
   */
  static withPlugins(modules: readonly DynamicModule[]): DynamicModule {
    return { module: AppModule, imports: [...modules] };
  }
}
