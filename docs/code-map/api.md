# Code map: the API

Generated from the source by `pnpm code-map`; `pnpm lint:guards` fails when it is stale. One section per directory of `apps/api/src`: the NestJS module it holds, if any, and every name each file exports. Suites are left out. Change the source and regenerate rather than editing this file.

## `apps/api/src`

`AppModule` in `apps/api/src/app.module.ts`.

- Imports: `ConfigModule`, `DatabaseModule`, `CryptoModule`, `ProtectedResourceModule`, `AuditModule`, `I18nModule`, `JobsModule`, `StorageModule`, `MediaModule`, `MailModule`, `SmsModule`, `AuthModule`, `PluginsModule`, `AuthorizationModule`, `InvitationsModule`, `SignupModule`, `SetupModule`, `SettingsModule`, `AddressesModule`, `AddressBookModule`, `RegistersModule`, `RolesModule`, `MovesModule`, `ImportModule`, `ThemesModule`, `PackagingModule`, `IssuesModule`, `BoardMailboxModule`, `DocumentsModule`, `ApartmentBinderModule`, `RetentionModule`, `DataProtectionModule`, `ContactModule`, `NewsModule`, `BoardModule`, `BookingsModule`, `EventsModule`, `MotionsModule`, `SubletsModule`, `KeyOrdersModule`, `MeetingsModule`, `ChargesModule`, `FeedModule`, `FeesModule`, `AccountingModule`, `ConnectedAppsModule`, `ManagementModule`, `ActionCatalogueModule`, `WellKnownModule`, `SiteModule`
- Controllers: `HealthController`
- Providers: `...EXCEPTION_FILTERS`, `PublicRateLimitGuard as APP_GUARD`

Exports by file:

- `apps/api/src/app.module.ts`: `AppModule`
- `apps/api/src/bootstrap.ts`: `loadBootEnv`, `listen`, `loadPluginsAtBoot`, `createApplication`, `blame`
- `apps/api/src/version.ts`: `PlatformVersion`, `platformVersion`, `readPlatformVersion`, `platformVersionLine`, `apiPackageDirectory`

## `apps/api/src/accounting`

`AccountingModule` in `apps/api/src/accounting/accounting.module.ts`. The accounting basis (bokforingsunderlag): what the association billed and charged in a period, as one file for whoever keeps its books.

- Imports: `ChargesModule`
- Controllers: `AccountingController`
- Providers: `AccountingBasisService`

Exports by file:

- `apps/api/src/accounting/accounting-basis.service.ts`: `AccountingBasisExport`, `AccountingBasisService`
- `apps/api/src/accounting/accounting-basis.ts`: `AccountingBasisRowKind`, `AccountingBasisApartment`, `AccountingBasisRow`, `AccountingBasis`, `ACCOUNTING_BASIS_COLUMNS`, `accountingBasisFileName`, `totalsOf`, `writeAccountingBasis`
- `apps/api/src/accounting/accounting.controller.ts`: `AccountingController`
- `apps/api/src/accounting/accounting.error.ts`: `AccountingError`
- `apps/api/src/accounting/accounting.module.ts`: `AccountingModule`

## `apps/api/src/actions`

`ActionCatalogueModule` in `apps/api/src/actions/action-catalogue.module.ts`. The catalogue endpoint, in a module of its own.

- Imports: `ActionsModule`
- Controllers: `ActionCatalogueController`

`ActionsModule` in `apps/api/src/actions/actions.module.ts`. The action registry, deliberately NOT global.

- Providers: `ActionRegistryService`, `ActionCallerFactory`, `CoreActionRegistrar`
- Exports: `ActionRegistryService`, `ActionCallerFactory`, `CoreActionRegistrar`

Exports by file:

- `apps/api/src/actions/action-caller.ts`: `ActionCaller`, `ResolvedCaller`, `RequestWithToken`, `ActionCallerFactory`
- `apps/api/src/actions/action-catalogue.controller.ts`: `ActionCatalogue`, `ActionCatalogueController`
- `apps/api/src/actions/action-catalogue.module.ts`: `ActionCatalogueModule`
- `apps/api/src/actions/action-denylist.ts`: `DENIED_ACTION_CAPABILITIES`, `PLUGIN_ELIGIBLE_CAPABILITIES`, `DENIED_ACTION_SERVICES`, `PERSON_FIELD_CATEGORIES`, `DENIED_NAME_PATTERNS`
- `apps/api/src/actions/action-errors.ts`: `PAGE_ACTION_ERRORS`, `NEWS_ACTION_ERRORS`, `MENU_ACTION_ERRORS`, `FACTS_ACTION_ERRORS`, `NEWS_COMMENT_ACTION_ERRORS`, `MOTION_ACTION_ERRORS`
- `apps/api/src/actions/action-registrar.ts`: `CoreActionRegistrar`
- `apps/api/src/actions/action-registry.service.ts`: `ActionOwner`, `PluginLiveness`, `RegisteredAction`, `ActionListFilter`, `ActionRegistryService`, `assertStrictAtEveryDepth`
- `apps/api/src/actions/action.error.ts`: `ACTION_ERROR_REASONS`, `ActionErrorReason`, `ActionError`, `ACTION_ERROR_MCP`
- `apps/api/src/actions/actions.module.ts`: `ActionsModule`
- `apps/api/src/actions/actor-of.ts`: `actorOf`
- `apps/api/src/actions/authenticated-request.ts`: `markAuthenticated`, `isAuthenticatedRequest`

## `apps/api/src/address-book`

`AddressBookModule` in `apps/api/src/address-book/address-book.module.ts`. The address book: the register the board works in, and the resident-facing view of it.

- Controllers: `AddressBookController`, `ResidentDirectoryController`
- Providers: `AddressBookService`, `ConsentService`, `PersonService`, `PersonReindexLock`, `PersonReindexService`
- Exports: `AddressBookService`, `ConsentService`, `PersonService`

Exports by file:

- `apps/api/src/address-book/address-book-projection.ts`: `ENCRYPTED_COLUMN_SUFFIX`, `BLIND_INDEX_COLUMN_SUFFIX`, `BOARD_PERSON_FIELDS`, `RESIDENT_PERSON_FIELDS`, `APARTMENT_FIELDS`
- `apps/api/src/address-book/address-book-view.ts`: `AddressBookAudience`, `AddressBookSign`, `AddressBookApartment`, `AddressBookContact`, `ResidentDirectoryRow`, `AddressBookRow`, `AddressBookRecord`, `MASKABLE_FIELDS`, `MaskableField`, `ALWAYS_MASKED_FIELDS`, `isMasked`, `isVisibleToResidents`, `signsFor`, `toAddressBookRow`, `toResidentDirectoryRow`
- `apps/api/src/address-book/address-book.controller.ts`: `AddressBookController`, `ResidentDirectoryController`
- `apps/api/src/address-book/address-book.module.ts`: `AddressBookModule`
- `apps/api/src/address-book/address-book.service.ts`: `AddressBookError`, `ADDRESS_BOOK_FILTERS`, `AddressBookFilter`, `AddressBookQuery`, `AddressBookAddress`, `AddressBookStats`, `AddressBookPage`, `AddressBookService`, `ApartmentResidencyView`, `ApartmentDetail`
- `apps/api/src/address-book/consent.service.ts`: `SetPublicationConsentInput`, `ConsentService`
- `apps/api/src/address-book/person-email-lock.ts`: `lockPersonEmail`, `lockPersonEmailsInOrder`
- `apps/api/src/address-book/person-identity-number-lock.ts`: `lockPersonIdentityNumber`, `lockPersonIdentityNumbersInOrder`
- `apps/api/src/address-book/person-reindex-lock.ts`: `PERSON_REINDEX_LOCK_KEY`, `PERSON_REINDEX_LOCK_APPLICATION_NAME`, `PersonReindexLockLostError`, `PersonReindexLock`
- `apps/api/src/address-book/person-reindex.service.ts`: `PERSON_REINDEX_QUEUE`, `PersonReindexJob`, `PersonReindexService`, `identityNumbersAwaitReindex`
- `apps/api/src/address-book/person.service.ts`: `PersonError`, `MaskedPostalAddress`, `PersonResidencyView`, `PersonBoardPositionView`, `PersonAccountView`, `ErasureWaitingOnView`, `PersonDetail`, `CreatePersonInput`, `RevealedFields`, `PersonService`
- `apps/api/src/address-book/publication-consent.ts`: `CONSENT_SCOPES`, `EveryConsentScopeIsListed`, `PublicationConsentState`, `PublicationConsentView`, `ConsentDates`, `PublicationConsentRecord`, `consentViewOf`, `consentStateFor`, `hasStandingConsent`

## `apps/api/src/addresses`

`AddressesModule` in `apps/api/src/addresses/addresses.module.ts`.

- Controllers: `AddressController`, `ApartmentController`
- Providers: `AddressService`
- Exports: `AddressService`

Exports by file:

- `apps/api/src/addresses/address.controller.ts`: `AddressController`, `ApartmentController`
- `apps/api/src/addresses/address.service.ts`: `AddressError`, `AddressView`, `ApartmentView`, `AddressInput`, `ApartmentRowInput`, `AddressService`
- `apps/api/src/addresses/addresses.module.ts`: `AddressesModule`

## `apps/api/src/apartment-binder`

`ApartmentBinderModule` in `apps/api/src/apartment-binder/apartment-binder.module.ts`. The apartment binder (lagenhetsparm).

- Imports: `MediaModule`
- Controllers: `ApartmentBinderShelfController`, `ApartmentBinderBoardController`
- Providers: `ApartmentBinderService`
- Exports: `ApartmentBinderService`

Exports by file:

- `apps/api/src/apartment-binder/apartment-binder-lock.ts`: `lockApartmentBinder`
- `apps/api/src/apartment-binder/apartment-binder.controller.ts`: `ApartmentBinderShelfController`, `ApartmentBinderBoardController`
- `apps/api/src/apartment-binder/apartment-binder.error.ts`: `BinderTextLocation`, `ApartmentBinderError`
- `apps/api/src/apartment-binder/apartment-binder.module.ts`: `ApartmentBinderModule`
- `apps/api/src/apartment-binder/apartment-binder.service.ts`: `BINDER_TITLE_MAX_LENGTH`, `BINDER_BYTES_PER_APARTMENT`, `BinderEntryView`, `BoardBinderEntryView`, `BinderView`, `BoardBinderSummaryView`, `BoardBinderView`, `FileEntryInput`, `ApartmentBinderService`, `refusePersonalIdentityNumbers`

## `apps/api/src/audit`

`AuditModule` in `apps/api/src/audit/audit.module.ts`, global. Auditing is cross-cutting: any module that touches protected personal data or produces a register extract has to write to the log.

- Providers: `AuditLogService`
- Exports: `AuditLogService`

Exports by file:

- `apps/api/src/audit/actor-context.ts`: `ActorContext`, `webActor`, `auditActor`
- `apps/api/src/audit/audit-log.service.ts`: `AuditDbClient`, `AuditEntryInput`, `AuditLogService`
- `apps/api/src/audit/audit.module.ts`: `AuditModule`

## `apps/api/src/auth`

`AuthModule` in `apps/api/src/auth/auth.module.ts`, global. Authentication is needed by every guard, so the service is global while the controller only mounts the Better Auth routes.

- Controllers: `AuthController`
- Providers: `AuthService`
- Exports: `AuthService`

`ProtectedResourceModule` in `apps/api/src/auth/protected-resource.module.ts`, global. Global, and it has to be.

- Providers: `PROTECTED_RESOURCE`
- Exports: `PROTECTED_RESOURCE`

`WellKnownModule` in `apps/api/src/auth/well-known.module.ts`. Its own module so that its position in AppModule's imports can be chosen.

- Controllers: `WellKnownController`

Exports by file:

- `apps/api/src/auth/auth-options.ts`: `RATE_LIMIT_MAX`, `SESSION_READ_PATH`, `SESSION_READ_MAX`, `SESSION_READ_WINDOW_SECONDS`, `CLIENT_MANAGEMENT_PATHS`, `USER_UPDATE_PATH`, `CALLER_SETTABLE_USER_FIELDS`, `CIMD_METADATA_RULES`, `AccountState`, `MagicLinkDelivery`, `ClientManagement`, `deliverMagicLink`, `buildAuthOptions`
- `apps/api/src/auth/auth.controller.ts`: `AuthController`
- `apps/api/src/auth/auth.module.ts`: `AuthModule`
- `apps/api/src/auth/auth.service.ts`: `AuthInstance`, `SHUTDOWN_GRACE_MS`, `HTTP_CLOSE_GRACE_MS`, `AuthService`
- `apps/api/src/auth/bearer-errors.ts`: `BearerUnauthorizedError`, `TokenRateLimitedError`
- `apps/api/src/auth/bearer-principal.service.ts`: `BearerIdentity`, `BearerPrincipalService`
- `apps/api/src/auth/cimd-fetch.ts`: `isMetadataDocumentUrlAllowed`, `metadataDocumentPolicy`, `MetadataFetchCode`, `MetadataFetchError`, `MetadataResourceFetch`, `MetadataFetchDependencies`, `REAL_DEPENDENCIES`, `createGuardedMetadataFetch`, `guardedMetadataFetch`
- `apps/api/src/auth/cimd-redirects.ts`: `refusingUnacceptableRedirects`, `cimdMetadataFetch`
- `apps/api/src/auth/fastify-bridge.ts`: `forwardHeaders`, `originOf`, `toWebRequest`, `sendWebResponse`
- `apps/api/src/auth/opaque-token.ts`: `hashOpaqueToken`, `tokensMatch`
- `apps/api/src/auth/protected-resource.module.ts`: `PROTECTED_RESOURCE`, `ProtectedResourceModule`
- `apps/api/src/auth/protected-resource.ts`: `DEFAULT_RESOURCE_PLUGIN_ID`, `DEFAULT_RESOURCE_PATH`, `ProtectedResource`, `ResolvedProtectedResource`, `isResourcePath`, `resolveProtectedResource`, `setProtectedResource`, `protectedResource`
- `apps/api/src/auth/resource-challenge.ts`: `resourceMetadataUrl`, `unauthorizedChallenge`, `insufficientScopeChallenge`
- `apps/api/src/auth/token-rate-limit.ts`: `DEFAULT_TOKEN_CALLS_PER_MINUTE`, `TokenRateLimitVerdict`, `TokenRateLimiter`
- `apps/api/src/auth/well-known.controller.ts`: `WellKnownController`
- `apps/api/src/auth/well-known.module.ts`: `WellKnownModule`

## `apps/api/src/authorization`

`AuthorizationModule` in `apps/api/src/authorization/authorization.module.ts`, global. Registers authorization as a global guard so protection is the default and exposure is the explicit choice (see the Public decorator).

- Controllers: `MeController`
- Providers: `PrincipalService`, `BearerPrincipalService`, `AuthorizationGuard`, `AuthorizationGuard as APP_GUARD`
- Exports: `PrincipalService`, `AuthorizationGuard`

Exports by file:

- `apps/api/src/authorization/authorization.guard.ts`: `RequestToken`, `RequestWithPrincipal`, `AuthorizationGuard`
- `apps/api/src/authorization/authorization.module.ts`: `AuthorizationModule`
- `apps/api/src/authorization/capabilities.ts`: `CAPABILITIES`, `Capability`, `SeatBoundCapability`, `GrantableCapability`, `isSeatBound`, `PrincipalRoles`, `capabilitiesFor`, `Principal`, `principalCan`
- `apps/api/src/authorization/me.controller.ts`: `ViewerView`, `MeController`
- `apps/api/src/authorization/principal.service.ts`: `PrincipalService`
- `apps/api/src/authorization/public.decorator.ts`: `IS_PUBLIC_ROUTE`, `Public`
- `apps/api/src/authorization/require-capability.decorator.ts`: `REQUIRED_CAPABILITIES`, `RequireCapability`

## `apps/api/src/board`

`BoardModule` in `apps/api/src/board/board.module.ts`. The association's board, as the association publishes it.

- Providers: `BoardRosterService`
- Exports: `BoardRosterService`

Exports by file:

- `apps/api/src/board/board-roster.service.ts`: `BoardRosterService`
- `apps/api/src/board/board-roster.ts`: `ROSTER_POSITIONS`, `EveryPositionIsOrdered`, `BoardSeat`, `POSITION_LABEL_KEYS`, `BoardRosterEntry`, `publishableRoster`
- `apps/api/src/board/board.module.ts`: `BoardModule`

## `apps/api/src/board-mailbox`

`BoardMailboxModule` in `apps/api/src/board-mailbox/board-mailbox.module.ts`. The board mailbox (styrelsens brevlada): collecting the board's address into this instance, working the threads it produces, and erasing them when their retention runs out.

- Imports: `MediaModule`
- Controllers: `BoardMailboxController`
- Providers: `BoardMailboxService`, `BoardMailboxCollectorService`, `BoardMailboxMailerService`, `BoardMailboxPurgeService`
- Exports: `BoardMailboxService`, `BoardMailboxCollectorService`

Exports by file:

- `apps/api/src/board-mailbox/address-domain.ts`: `AddressDomainIdentity`, `SCRIPT_CODES`, `addressDomainIdentity`
- `apps/api/src/board-mailbox/board-mailbox-collector.service.ts`: `BOARD_MAILBOX_COLLECT_QUEUE`, `MAX_MESSAGES_PER_COLLECTION`, `CollectionSummary`, `BoardMailboxCollectorService`
- `apps/api/src/board-mailbox/board-mailbox-delivery.ts`: `REPLY_DELIVERY_FAILURES`, `ReplyDeliveryFailure`, `COLLECTION_REFUSALS`, `CollectionRefusal`, `LISTED_REFUSALS`
- `apps/api/src/board-mailbox/board-mailbox-mailer.service.ts`: `BOARD_MAILBOX_REPLY_QUEUE`, `BOARD_MAILBOX_REPLY_ABANDONED_QUEUE`, `BoardMailboxMailerService`
- `apps/api/src/board-mailbox/board-mailbox-purge.service.ts`: `BOARD_MAILBOX_PURGE_QUEUE`, `BoardMailboxPurgeRunSummary`, `BoardMailboxPurgeService`
- `apps/api/src/board-mailbox/board-mailbox-retention.ts`: `BOARD_MAILBOX_RETENTION_DAYS`, `computeBoardMailboxPurgeDate`, `boardMailboxPurgeCutoff`
- `apps/api/src/board-mailbox/board-mailbox-settings.ts`: `BoardMailboxSettings`, `BoardMailboxColumns`, `boardMailboxConfigured`, `loadBoardMailboxSettings`, `mailboxFingerprint`, `legacyMailboxFingerprint`
- `apps/api/src/board-mailbox/board-mailbox.controller.ts`: `BoardMailboxController`
- `apps/api/src/board-mailbox/board-mailbox.error.ts`: `BoardMailboxError`
- `apps/api/src/board-mailbox/board-mailbox.module.ts`: `BoardMailboxModule`
- `apps/api/src/board-mailbox/board-mailbox.service.ts`: `BoardMailboxCorrespondentView`, `BoardMemberView`, `BoardMailboxAttachmentView`, `BoardMailboxMessageView`, `BoardMailboxThreadSummary`, `BoardMailboxThreadView`, `BoardMailboxThreadList`, `INBOX_CURSOR`, `BoardMailboxStatusView`, `BoardMailboxSetAsideView`, `BoardMailboxService`
- `apps/api/src/board-mailbox/database-refusal.ts`: `isDataRefusal`
- `apps/api/src/board-mailbox/mime.ts`: `MAX_TEXT_CHARACTERS`, `MimeAttachment`, `ParsedMessage`, `ReadText`, `readMessage`, `MAX_PARTS`, `readBody`, `decodeEncodedWords`, `addressFrom`, `displayNameFrom`, `htmlToText`
- `apps/api/src/board-mailbox/pop3.ts`: `POP3_IMPLICIT_TLS_PORT`, `POP3_CLEARTEXT_PORT`, `defaultPop3Port`, `Pop3Credentials`, `Pop3ConnectOptions`, `Pop3Listing`, `Pop3Error`, `Pop3Session`, `openPop3Session`
- `apps/api/src/board-mailbox/testing/letter-date.ts`: `yesterdayDateHeader`
- `apps/api/src/board-mailbox/testing/pop3-test-server.ts`: `Pop3TestServerOptions`, `Pop3TestServer`, `startPop3TestServer`
- `apps/api/src/board-mailbox/thread-lock.ts`: `lockThread`

## `apps/api/src/bookings`

`BookingsModule` in `apps/api/src/bookings/bookings.module.ts`. Resource booking (bokning): what the association offers, who has booked it, and what becomes of the record that they did.

- Controllers: `BookingController`, `BookingAdminController`, `BookableResourceAdminController`
- Providers: `BookableResourceService`, `BookingService`, `BookingMailerService`, `BookingPurgeService`
- Exports: `BookableResourceService`, `BookingService`

Exports by file:

- `apps/api/src/bookings/bookable-resource.service.ts`: `BookableResourceView`, `BookableResourceSummary`, `BookableResourceInput`, `BookableResourceService`
- `apps/api/src/bookings/booking-lock.ts`: `lockApartmentBookings`, `lockResourceBookings`
- `apps/api/src/bookings/booking-mailer.service.ts`: `BookingMailInput`, `BookingMailerService`
- `apps/api/src/bookings/booking-purge.service.ts`: `BOOKING_PURGE_QUEUE`, `BookingPurgeRunSummary`, `BookingPurgeService`
- `apps/api/src/bookings/booking-retention.ts`: `BOOKING_RETENTION_DAYS`, `computeBookingPurgeDate`, `bookingPurgeCutoff`
- `apps/api/src/bookings/booking.error.ts`: `BookingQuota`, `BookingTextLocation`, `BookingError`
- `apps/api/src/bookings/booking.service.ts`: `BookingApartmentView`, `SlotState`, `BookableSlotView`, `OwnBookingView`, `BookingBookerView`, `ManagedBookingView`, `BookInput`, `BookingService`
- `apps/api/src/bookings/bookings.controller.ts`: `BookableResourceAdminController`, `BookingController`, `BookingAdminController`
- `apps/api/src/bookings/bookings.module.ts`: `BookingsModule`
- `apps/api/src/bookings/resource-schedule.ts`: `ResourceSchedule`, `ScheduleProblem`, `checkResourceSchedule`
- `apps/api/src/bookings/slot-engine.ts`: `MAX_SLOT_DAYS`, `MAX_BOOKING_NIGHTS`, `SlotResource`, `generateSlots`, `periodFor`, `daysIn`

## `apps/api/src/charges`

`ChargesModule` in `apps/api/src/charges/charges.module.ts`. Charges to members (debiteringar mot medlem): what the association put on a member or on an apartment, and the debiting list it is handed over as.

- Controllers: `MemberChargesController`
- Providers: `MemberChargeService`, `MemberChargePurgeService`
- Exports: `MemberChargeService`

Exports by file:

- `apps/api/src/charges/apartment-charges.ts`: `ResidencyPeriod`, `DatedApartmentCharge`, `chargesDuringResidency`
- `apps/api/src/charges/charges.module.ts`: `ChargesModule`
- `apps/api/src/charges/debiting-list.ts`: `DebitingListApartment`, `DebitingListParty`, `DebitingListRow`, `DebitingList`, `DEBITING_LIST_COLUMNS`, `debitingListFileName`, `writeDebitingList`, `sumChargeAmounts`
- `apps/api/src/charges/member-charge-lock.ts`: `lockMemberCharge`
- `apps/api/src/charges/member-charge-purge.service.ts`: `MEMBER_CHARGE_PURGE_QUEUE`, `MemberChargePurgeRunSummary`, `MemberChargePurgeService`
- `apps/api/src/charges/member-charge-retention.ts`: `MEMBER_CHARGE_RETENTION_YEARS`, `computeMemberChargePurgeDate`, `memberChargePurgeCutoff`
- `apps/api/src/charges/member-charge.error.ts`: `MemberChargeTextLocation`, `MemberChargeError`
- `apps/api/src/charges/member-charge.service.ts`: `MEMBER_CHARGE_TARGET_KIND`, `VatTreatment`, `RecordMemberChargeInput`, `CorrectMemberChargeInput`, `DebitingListExport`, `MemberChargeService`
- `apps/api/src/charges/member-charges.controller.ts`: `MemberChargesController`

## `apps/api/src/cli`

Exports by file:

- `apps/api/src/cli/failure-lines.ts`: `failureLines`
- `apps/api/src/cli/terminal-text.ts`: `terminalText`

## `apps/api/src/config`

`ConfigModule` in `apps/api/src/config/config.module.ts`, global.

- Providers: `ENV`
- Exports: `ENV`

Exports by file:

- `apps/api/src/config/config.module.ts`: `ENV`, `ConfigModule`
- `apps/api/src/config/env.ts`: `isLoopbackAddress`, `envSchema`, `Env`, `applicationDatabaseUrl`, `EnvValidationError`, `loadEnv`
- `apps/api/src/config/load-env-file.ts`: `loadNearestEnvFile`
- `apps/api/src/config/process-role.ts`: `ProcessRole`, `PROCESS_ROLE_VARIABLE`, `processRole`

## `apps/api/src/connected-apps`

`ConnectedAppsModule` in `apps/api/src/connected-apps/connected-apps.module.ts`. Seeing, granting and cutting a member's connected apps.

- Controllers: `MyConnectedAppsController`, `ConnectedAppsAdminController`, `OAuthConsentController`, `OAuthClientsController`
- Providers: `ConnectedAppsService`
- Exports: `ConnectedAppsService`

Exports by file:

- `apps/api/src/connected-apps/client-host.ts`: `hostOf`, `connectedAppHost`
- `apps/api/src/connected-apps/connected-apps.controller.ts`: `MyConnectedAppsController`, `ConnectedAppsAdminController`, `OAuthConsentController`
- `apps/api/src/connected-apps/connected-apps.module.ts`: `ConnectedAppsModule`
- `apps/api/src/connected-apps/connected-apps.service.ts`: `UnknownClientError`, `ConnectedAppView`, `ConnectedAppGrantView`, `ConnectedAppsService`
- `apps/api/src/connected-apps/oauth-clients.controller.ts`: `InvalidRedirectUriError`, `applicationTypeFor`, `OAuthClientsController`

## `apps/api/src/contact`

`ContactModule` in `apps/api/src/contact/contact.module.ts`. The website's contact form, from the message arriving to the board reading it.

- Controllers: `ContactSubmissionController`
- Providers: `ContactService`
- Exports: `ContactService`

Exports by file:

- `apps/api/src/contact/contact.controller.ts`: `ContactSubmissionController`
- `apps/api/src/contact/contact.error.ts`: `ContactError`
- `apps/api/src/contact/contact.module.ts`: `ContactModule`
- `apps/api/src/contact/contact.service.ts`: `CONTACT_FANOUT_QUEUE`, `CONTACT_NOTICE_QUEUE`, `CONTACT_ABANDONED_QUEUE`, `NOTIFIED_SUBMISSIONS_PER_HOUR`, `ContactFanoutJob`, `ContactNoticeJob`, `SubmitContactMessageInput`, `ContactSubmissionView`, `ContactInboxPage`, `INBOX_PAGE_SIZE`, `ContactService`

## `apps/api/src/crypto`

`CryptoModule` in `apps/api/src/crypto/crypto.module.ts`, global. Field encryption is needed wherever personal data is read or written, so the module is global rather than imported into every feature module.

- Providers: `FieldEncryptionService`
- Exports: `FieldEncryptionService`

Exports by file:

- `apps/api/src/crypto/crypto.module.ts`: `CryptoModule`
- `apps/api/src/crypto/encryption-key.provider.ts`: `EncryptionKeyError`, `EncryptionKeyProvider`
- `apps/api/src/crypto/field-encryption.service.ts`: `EncryptedFieldId`, `EncryptedValue`, `FieldEncryptionService`
- `apps/api/src/crypto/personal-data.ts`: `NORMALIZATION_VERSION`, `normalizeEmail`, `normalizePhone`
- `apps/api/src/crypto/stored-file-cipher.ts`: `STORED_FILE_CHUNK_BYTES`, `SEALED_FILE_CONTENT_TYPE`, `SealedFileError`, `newFileKey`, `sealedLength`, `sealFile`, `openSealedFile`
- `apps/api/src/crypto/testing/sealed-file-fixture.ts`: `SEALED_FIXTURE_PLAINTEXT_BYTES`, `sealedFixturePlaintext`, `SEALED_FIXTURE_KEY`, `SEALED_FIXTURE`

## `apps/api/src/data-protection`

`DataProtectionModule` in `apps/api/src/data-protection/data-protection.module.ts`. Data protection (dataskydd): what the association owes as controller.

- Imports: `RetentionModule`
- Controllers: `DataProtectionController`, `DataSubjectRequestController`, `DataPortabilityController`
- Providers: `BreachService`, `BreachReminderService`, `DataSubjectRequestService`, `DataPortabilityRateLimiter`, `ProcessingActivityService`, `ProcessorFactsService`, `ProcessorAgreementService`, `PrivacyNoticeService`, `DataProtectionOverviewService`, `DataProtectionSeedService`
- Exports: `DataSubjectRequestService`, `ProcessingActivityService`, `ProcessorAgreementService`, `ProcessorFactsService`, `DataProtectionSeedService`

Exports by file:

- `apps/api/src/data-protection/breach-deadline.ts`: `BREACH_NOTIFICATION_HOURS`, `BREACH_REMINDER_HOURS_LEFT`, `BreachClock`, `imyNotificationOwed`, `computeBreachDeadline`, `computeBreachReminderAt`, `hoursLeft`, `breachState`
- `apps/api/src/data-protection/breach-lock.ts`: `lockBreach`
- `apps/api/src/data-protection/breach-reminder.queue.ts`: `BREACH_REMINDER_QUEUE`, `BreachReminderJob`, `BREACH_REMINDER_RETRY`
- `apps/api/src/data-protection/breach-reminder.service.ts`: `BreachReminderService`
- `apps/api/src/data-protection/breach.error.ts`: `BreachError`
- `apps/api/src/data-protection/breach.service.ts`: `BreachView`, `BreachService`
- `apps/api/src/data-protection/data-portability-rate-limit.ts`: `EXPORTS_PER_PERSON_PER_MINUTE`, `EXPORTS_PER_MINUTE_OVERALL`, `DataPortabilityLimit`, `DataPortabilityRateLimitedError`, `DataPortabilityRateLimiter`
- `apps/api/src/data-protection/data-portability.controller.ts`: `DataPortabilityController`
- `apps/api/src/data-protection/data-portability.ts`: `DataPortabilityExport`, `PortableResidency`, `PortablePublicationConsent`, `PortableBooking`, `PortableMotion`, `PortableEventSignup`, `PortableSubletApplication`, `PortableConnectedApp`, `PortableKeyOrder`, `TRANSMISSION_NOTE_KEY`, `SCOPE_NOTE_KEY`, `toDataPortabilityExport`
- `apps/api/src/data-protection/data-protection-overview.service.ts`: `DataProtectionOverview`, `DataProtectionOverviewService`
- `apps/api/src/data-protection/data-protection-seed.service.ts`: `DataProtectionSeedService`
- `apps/api/src/data-protection/data-protection.controller.ts`: `DataProtectionController`
- `apps/api/src/data-protection/data-protection.module.ts`: `DataProtectionModule`
- `apps/api/src/data-protection/data-subject-request-lock.ts`: `lockDataSubjectRequests`
- `apps/api/src/data-protection/data-subject-request.controller.ts`: `DataSubjectRequestController`
- `apps/api/src/data-protection/data-subject-request.error.ts`: `DataSubjectRequestReason`, `DataSubjectRequestError`
- `apps/api/src/data-protection/data-subject-request.service.ts`: `DataSubjectRequestService`
- `apps/api/src/data-protection/data-subject-request.ts`: `DataSubjectRequestRow`, `DataSubjectRequestView`, `DataSubjectRequestState`, `dueOn`, `requestState`, `isPastDue`, `canExtend`, `toDataSubjectRequestView`
- `apps/api/src/data-protection/folded-text.ts`: `foldedText`
- `apps/api/src/data-protection/privacy-notice.service.ts`: `PrivacyNoticeError`, `PrivacyNoticeCoverage`, `PrivacyNoticeService`
- `apps/api/src/data-protection/processing-activity-lock.ts`: `lockProcessingActivity`
- `apps/api/src/data-protection/processing-activity-seed.ts`: `SeedRow`, `SEED_KEYS`, `SeedKey`, `legalBasisOf`, `MAIL_TEMPLATES`, `securityMeasuresFor`, `seedRows`
- `apps/api/src/data-protection/processing-activity.service.ts`: `ProcessingActivityError`, `ProcessingActivityView`, `ControllerBlock`, `ProcessingRecord`, `ProcessingActivityService`, `ActivityInput`
- `apps/api/src/data-protection/processor-agreement-lock.ts`: `lockProcessorAgreement`
- `apps/api/src/data-protection/processor-agreement.service.ts`: `ProcessorAgreementError`, `ProcessorView`, `ProcessorAgreementInput`, `ProcessorAgreementService`, `assertConsistent`
- `apps/api/src/data-protection/processor-facts.service.ts`: `ProcessorFactsService`
- `apps/api/src/data-protection/processor-key.ts`: `PROCESSOR_KEYS`, `FixedProcessorKey`, `pluginProcessorKey`, `externalProcessorKey`, `PENDING_EXTERNAL_PROCESSOR_KEY_PREFIX`, `pendingExternalProcessorKey`, `connectedAppProcessorKey`, `processorKeySchema`, `ParsedProcessorKey`, `parseProcessorKey`
- `apps/api/src/data-protection/processors.ts`: `ProcessorFacts`, `OpenAgreementRow`, `ProcessorAgreementState`, `ProcessorDescriptor`, `stateOf`, `smsGatewayHost`, `currentProcessors`
- `apps/api/src/data-protection/section-processing.ts`: `ReportSection`, `Portability`, `DocumentPart`, `SectionProcessing`, `SECTION_PROCESSING`, `ProcessedSection`, `PortableSection`, `REPORTED_SECTIONS`, `PORTABLE_SECTIONS`

## `apps/api/src/database`

`DatabaseModule` in `apps/api/src/database/database.module.ts`, global. Database access is needed by nearly every feature module, so the client is provided globally rather than imported repeatedly.

- Providers: `PrismaService`
- Exports: `PrismaService`

Exports by file:

- `apps/api/src/database/database.module.ts`: `DatabaseModule`
- `apps/api/src/database/prisma.service.ts`: `PrismaService`
- `apps/api/src/database/runtime-role.ts`: `RawQueryable`, `ARCHIVE_REVOKES`, `runtimeRoleProblems`, `assertConstrainedRuntimeRole`
- `apps/api/src/database/sql-state.ts`: `DATABASE_ERROR_CODES`, `prismaCode`, `sqlState`
- `apps/api/src/database/testing/postgres-errors.ts`: `postgres`, `mapped`
- `apps/api/src/database/unique-violation.ts`: `isUniqueViolation`

## `apps/api/src/documents`

`DocumentsModule` in `apps/api/src/documents/documents.module.ts`. The association's document archive.

- Imports: `MediaModule`
- Controllers: `DocumentShelfController`, `DocumentArchiveController`
- Providers: `DocumentsService`
- Exports: `DocumentsService`

Exports by file:

- `apps/api/src/documents/document-lock.ts`: `lockDocument`
- `apps/api/src/documents/documents.controller.ts`: `DocumentShelfController`, `DocumentArchiveController`
- `apps/api/src/documents/documents.module.ts`: `DocumentsModule`
- `apps/api/src/documents/documents.service.ts`: `DocumentTextLocation`, `DocumentError`, `DocumentView`, `AddDocumentInput`, `EditDocumentInput`, `audiencesFor`, `DocumentsService`

## `apps/api/src/events`

`EventsModule` in `apps/api/src/events/events.module.ts`. The event calendar (evenemangskalender): what the association arranges, when it happens, who is told about it, and who is coming.

- Controllers: `EventAdminController`, `EventSignupController`, `EventAttendanceAdminController`
- Providers: `EventService`, `EventSignupService`, `EventSignupPurgeService`
- Exports: `EventService`, `EventSignupService`

Exports by file:

- `apps/api/src/events/event-attendance.ts`: `EventDbClient`, `occurrencesWithSignups`
- `apps/api/src/events/event-lock.ts`: `lockEvent`, `lockEventOfOccurrence`
- `apps/api/src/events/event-signup-lock.ts`: `lockOccurrenceSignups`, `lockOccurrencesSignups`
- `apps/api/src/events/event-signup-purge.service.ts`: `EVENT_SIGNUP_PURGE_QUEUE`, `EventSignupPurgeRunSummary`, `EventSignupPurgeService`
- `apps/api/src/events/event-signup-retention.ts`: `EVENT_SIGNUP_RETENTION_DAYS`, `computeEventSignupPurgeDate`, `eventSignupPurgeCutoff`
- `apps/api/src/events/event-signup.service.ts`: `SIGNUP_TARGET_KIND`, `OwnSignupView`, `AttendableOccurrenceView`, `EventAttendeeView`, `RollCallEntryView`, `RollCallView`, `EventSignupService`, `placesLeftOf`, `attendeeOf`
- `apps/api/src/events/event-signups.controller.ts`: `EventSignupController`, `EventAttendanceAdminController`
- `apps/api/src/events/event.error.ts`: `EventTextLocation`, `EventError`
- `apps/api/src/events/event.service.ts`: `MAX_CALENDAR_DAYS`, `EventCalendarWindow`, `EventRecurrenceView`, `EventOccurrenceView`, `EventView`, `EventInput`, `PublishEventInput`, `EventService`
- `apps/api/src/events/events.controller.ts`: `EventAdminController`
- `apps/api/src/events/events.module.ts`: `EventsModule`
- `apps/api/src/events/occurrence-plan.ts`: `StoredOccurrence`, `MovedOccurrence`, `OccurrencePlan`, `displacedBy`, `planOccurrences`
- `apps/api/src/events/recurrence.ts`: `RECURRENCE_HORIZON_DAYS`, `MAX_OCCURRENCES`, `MAX_DURATION_MINUTES`, `RecurrenceRule`, `SeriesSchedule`, `RecurrenceProblem`, `checkRecurrenceSchedule`, `recurrenceDays`, `occurrencePeriods`

## `apps/api/src/feed`

`FeedModule` in `apps/api/src/feed/feed.module.ts`. The feed: the audiences somebody is in, what is posted to them, the comments and likes under each post, the way a group's post reaches the board, and the clock that empties all of it (ADR 0026).

- Imports: `MediaModule`
- Controllers: `FeedController`, `GroupController`, `PostReportController`
- Providers: `FeedService`, `PostCommentService`, `GroupService`, `PostReportService`, `FeedPurgeService`

Exports by file:

- `apps/api/src/feed/feed-audience.ts`: `FeedDbClient`, `AudienceRow`, `AUDIENCE_COLUMNS`, `livesHere`, `isInAudience`, `audienceFor`, `audiencesFor`, `derivedAudience`, `isGroupMember`, `isWrittenIntoGroup`, `groupsFor`, `shownAt`, `ReachablePost`, `postFor`, `refuseErasedPost`
- `apps/api/src/feed/feed-author.ts`: `AUTHOR_COLUMNS`, `AuthorRow`, `authorViewOf`, `readAuthors`
- `apps/api/src/feed/feed-cursor.ts`: `FeedCursor`, `feedCursor`, `parseFeedCursor`, `olderThan`, `newerThan`
- `apps/api/src/feed/feed-image.ts`: `MAX_IMAGES_PER_POST`, `ATTACHABLE_HOURS`, `UNATTACHED_IMAGE_HOURS`, `UPLOADS_PER_DAY`, `PostImageAccess`, `postImageAccess`
- `apps/api/src/feed/feed-lock.ts`: `lockAudience`, `lockFeedOrder`, `lockPostThread`, `lockPost`, `lockFeedPerson`
- `apps/api/src/feed/feed-purge.service.ts`: `FEED_PURGE_QUEUE`, `FeedPurgeRunSummary`, `FeedPurgeService`
- `apps/api/src/feed/feed-retention.ts`: `FEED_RETENTION_DAYS`, `computeFeedPurgeDate`, `feedPurgeCutoff`
- `apps/api/src/feed/feed.controller.ts`: `requirePrincipal`, `FeedController`
- `apps/api/src/feed/feed.error.ts`: `FeedTextLocation`, `FeedError`, `refusePersonalIdentityNumbers`
- `apps/api/src/feed/feed.module.ts`: `FeedModule`
- `apps/api/src/feed/feed.service.ts`: `POST_MAX_LENGTH`, `POSTS_PER_WRITE_WINDOW`, `WRITE_WINDOW_MINUTES`, `POSTS_PER_PAGE`, `SEARCH_MAX_LENGTH`, `FeedQuery`, `WritePostInput`, `UploadImageInput`, `FeedService`, `stampAfterNewest`, `putNewsItemInFeed`
- `apps/api/src/feed/group.controller.ts`: `GroupController`
- `apps/api/src/feed/group.service.ts`: `GROUP_NAME_MAX_LENGTH`, `GROUPS_PER_PERSON`, `MEMBERS_PER_GROUP`, `GroupService`
- `apps/api/src/feed/post-comment.service.ts`: `COMMENT_MAX_LENGTH`, `COMMENTS_PER_WRITE_WINDOW`, `COMMENT_WINDOW_MINUTES`, `COMMENTS_PER_PAGE`, `PostCommentService`, `refuseTooManyComments`, `stampCommentAfterNewest`
- `apps/api/src/feed/post-report-access.ts`: `OPEN_REPORT`, `answersReports`, `isReportedToBoard`
- `apps/api/src/feed/post-report.controller.ts`: `PostReportController`
- `apps/api/src/feed/post-report.service.ts`: `REPORT_NOTE_MAX_LENGTH`, `REPORTS_PER_PAGE`, `PostReportService`

## `apps/api/src/fees`

`FeesModule` in `apps/api/src/fees/fees.module.ts`. The fees the apartments pay (avgifter), and the notices issued from them.

- Controllers: `FeesController`, `FeeNotificationsController`
- Providers: `FeeService`, `FeeNotificationService`, `FeePurgeService`
- Exports: `FeeService`, `FeeNotificationService`

Exports by file:

- `apps/api/src/fees/fee-lock.ts`: `lockFeeRates`, `lockFeeNotifications`, `lockedNow`
- `apps/api/src/fees/fee-notice.ts`: `FeeNoticeHolders`, `FeeNoticeRow`, `FeeNoticeDocument`, `FEE_NOTICE_COLUMNS`, `feeNoticeListFileName`, `totalOf`, `writeFeeNoticeList`
- `apps/api/src/fees/fee-notification.service.ts`: `FeeNotificationSummary`, `FeeNoticeExport`, `IssueNotificationInput`, `FeeNotificationService`
- `apps/api/src/fees/fee-period.ts`: `firstMonthBilled`, `monthsIn`, `MAX_MONTHS_PER_PERIOD`, `isWholeMonths`, `lastDayOfMonth`, `formatPeriod`, `sumAmounts`, `amountForMonths`
- `apps/api/src/fees/fee-purge.service.ts`: `FEE_PURGE_QUEUE`, `FeePurgeRunSummary`, `FeePurgeService`
- `apps/api/src/fees/fee-retention.ts`: `FEE_RETENTION_YEARS`, `computeFeePurgeDate`, `feePurgeCutoff`
- `apps/api/src/fees/fee.error.ts`: `FeeError`
- `apps/api/src/fees/fee.service.ts`: `FEE_TARGET_KIND`, `FEE_KINDS`, `FeeKind`, `FeeVatTreatment`, `FeeRow`, `FeeRegisterApartment`, `FeeRegister`, `RecordFeeInput`, `FeeService`
- `apps/api/src/fees/fees.controller.ts`: `FeesController`, `FeeNotificationsController`
- `apps/api/src/fees/fees.module.ts`: `FeesModule`
- `apps/api/src/fees/payment-reference.ts`: `MAX_NOTICES_PER_RUN`, `paymentReferenceFor`, `paymentReferenceIsWellFormed`

## `apps/api/src/health`

Exports by file:

- `apps/api/src/health/health.controller.ts`: `HealthStatus`, `HealthController`

## `apps/api/src/http`

Exports by file:

- `apps/api/src/http/app-base-path.ts`: `APP_BASE_PATH`, `applicationUrl`
- `apps/api/src/http/blank-to-null.ts`: `blankToNull`
- `apps/api/src/http/domain-error.ts`: `DomainError`
- `apps/api/src/http/domain-exception.filter.ts`: `DomainExceptionFilter`
- `apps/api/src/http/honeypot.ts`: `HONEYPOT_FIELD`, `isHoneypotFilled`, `droppedSubmissionId`
- `apps/api/src/http/multipart.ts`: `UploadedFile`, `registerMultipart`, `isTooLarge`, `readSingleFile`
- `apps/api/src/http/public-rate-limit.decorator.ts`: `PUBLIC_RATE_LIMIT`, `PublicRateLimitOptions`, `PublicRateLimit`
- `apps/api/src/http/public-rate-limit.guard.ts`: `TooManyRequestsError`, `RateLimitDecision`, `trustedProxyList`, `clientAddressOf`, `TokenBuckets`, `PublicRateLimitGuard`
- `apps/api/src/http/security-headers.ts`: `securityHeaders`, `registerSecurityHeaders`
- `apps/api/src/http/serve-single-page-app.ts`: `APP_CONTENT_SECURITY_POLICY`, `isApiRequest`, `isAppRequest`, `NotFoundRenderer`, `serveSinglePageApp`
- `apps/api/src/http/unhandled-exception.filter.ts`: `UnhandledExceptionFilter`, `EXCEPTION_FILTERS`

## `apps/api/src/i18n`

`I18nModule` in `apps/api/src/i18n/i18n.module.ts`, global. Translation is needed by mail, PDF extracts and every error surface.

- Providers: `I18nService`
- Exports: `I18nService`

Exports by file:

- `apps/api/src/i18n/i18n.module.ts`: `I18nModule`
- `apps/api/src/i18n/i18n.service.ts`: `SUPPORTED_LOCALES`, `Locale`, `DEFAULT_LOCALE`, `FALLBACK_LOCALE`, `I18nService`

## `apps/api/src/import`

`ImportModule` in `apps/api/src/import/import.module.ts`. The one-time import of an existing member list.

- Controllers: `ImportController`
- Providers: `ImportService`, `ImportPlannerService`, `ImportPreviewService`, `ImportApplyService`
- Exports: `ImportService`, `ImportPreviewService`, `ImportApplyService`

Exports by file:

- `apps/api/src/import/csv.ts`: `CsvDelimiter`, `ParsedCsv`, `detectDelimiter`, `MixedEncodingError`, `decodeCsv`, `CsvLimits`, `parseCsv`, `writeCsv`
- `apps/api/src/import/import-apply.service.ts`: `IMPORT_APPLY_QUEUE`, `IMPORT_APPLY_DEAD_LETTER_QUEUE`, `IMPORT_CHUNK_ROWS`, `IMPORT_CHUNK_TRANSACTION_MS`, `ImportApplyService`, `stopImport`, `finishImport`, `readDecisions`
- `apps/api/src/import/import-columns.ts`: `IMPORT_FIELDS`, `ImportField`, `ImportMapping`, `normalizeHeader`, `suggestMapping`, `readMapping`, `validateMapping`, `splitFullName`, `parseRole`, `parseImportDate`
- `apps/api/src/import/import-errors.ts`: `ImportErrorReason`, `ImportError`
- `apps/api/src/import/import-limits.ts`: `MAX_WORKBOOK_ENTRY_BYTES`, `MAX_WORKBOOK_BYTES`, `MAX_WORKBOOK_EMPTY_ROW`, `MAX_WORKBOOK_EMPTY_COLUMN`, `ImportShapeReason`, `ImportShapeError`
- `apps/api/src/import/import-lock.ts`: `lockImportApply`
- `apps/api/src/import/import-plan.ts`: `ImportRole`, `ImportOutcome`, `ImportMatchKey`, `IMPORT_SEARCH_KEYS`, `ImportSearchKey`, `ImportMismatch`, `ImportProblem`, `RegisterApartment`, `RegisterResidency`, `registerResidency`, `RegisterSnapshot`, `PreparedRow`, `ImportDefaults`, `PlannedPerson`, `PlannedRow`, `ImportCandidate`, `ImportPlan`, `ImportDecision`, `ImportDecisions`, `UnwrittenIdentityNumber`, `apartmentNameKey`, `readRow`, `hasIndexableIdentityNumber`, `planImport`, `RowResidency`, `rowResidency`, `heldAlready`, `conflictsWith`, `findUndecided`, `PreviewedCandidates`, `findUnpreviewed`, `changedSincePreview`, `readPreviewedCandidates`, `previewedTargets`, `retargetedSincePreview`, `readPreviewedTargets`, `push`
- `apps/api/src/import/import-planner.service.ts`: `IdentityIndexCache`, `ImportPlanRequest`, `ImportPlannerService`, `assertMappingApplies`
- `apps/api/src/import/import-preview.service.ts`: `IMPORT_PREVIEW_QUEUE`, `IMPORT_PREVIEW_ABANDONED_QUEUE`, `PREVIEW_PROGRESS_ROWS`, `PREVIEW_UNWATCHED_MS`, `ImportPreviewRow`, `ImportPreview`, `ImportPreviewRun`, `IMPORT_PREVIEW_SELECT`, `ImportPreviewService`
- `apps/api/src/import/import-revision.ts`: `readImportRevision`, `advanceImportRevision`
- `apps/api/src/import/import-run.ts`: `ImportRunStatus`, `RUNNING_IMPORT_STATUSES`, `ImportApplyResult`, `ImportRunView`, `IMPORT_RUN_SELECT`, `ImportRunRow`, `toRunView`, `isRunning`
- `apps/api/src/import/import.controller.ts`: `ImportController`
- `apps/api/src/import/import.module.ts`: `ImportModule`
- `apps/api/src/import/import.service.ts`: `IMPORT_PURGE_QUEUE`, `ImportSessionView`, `ImportMappingInput`, `ImportPreviewInput`, `ImportService`
- `apps/api/src/import/sheet-addresses.ts`: `UnreadableSheetError`, `checkAddresses`
- `apps/api/src/import/workbook.ts`: `cellText`, `inspectWorkbook`, `parseWorkbook`

## `apps/api/src/invitations`

`InvitationsModule` in `apps/api/src/invitations/invitations.module.ts`.

- Controllers: `InvitationController`, `InvitationAcceptController`
- Providers: `InvitationService`
- Exports: `InvitationService`

Exports by file:

- `apps/api/src/invitations/invitation.controller.ts`: `InvitationController`, `InvitationAcceptController`
- `apps/api/src/invitations/invitation.service.ts`: `InvitationError`, `InvitationService`, `hashToken`
- `apps/api/src/invitations/invitations.module.ts`: `InvitationsModule`

## `apps/api/src/issues`

`IssuesModule` in `apps/api/src/issues/issues.module.ts`. Reported issues: the board's type catalogue, the resident's report, and the queue whoever handles issues works from.

- Imports: `MediaModule`
- Controllers: `IssueReportController`, `IssueQueueController`, `IssueTypeAdminController`
- Providers: `IssueService`, `IssueTypeService`, `IssuePurgeService`
- Exports: `IssueService`, `IssueTypeService`

Exports by file:

- `apps/api/src/issues/issue-audience.ts`: `reportableAudiences`
- `apps/api/src/issues/issue-lock.ts`: `lockIssue`
- `apps/api/src/issues/issue-purge.service.ts`: `ISSUE_PURGE_QUEUE`, `IssuePurgeRunSummary`, `IssuePurgeService`
- `apps/api/src/issues/issue-retention.ts`: `ISSUE_RETENTION_DAYS`, `computeIssuePurgeDate`, `issuePurgeCutoff`
- `apps/api/src/issues/issue-type.service.ts`: `IssueTypeView`, `ReportableIssueTypeView`, `IssueTypeInput`, `IssueTypeService`
- `apps/api/src/issues/issue.error.ts`: `IssueError`
- `apps/api/src/issues/issue.service.ts`: `MAX_PHOTOS_PER_ISSUE`, `IssuePhotoView`, `IssueApartmentView`, `IssueReporterView`, `OwnIssueView`, `QueuedIssueView`, `ReportIssueInput`, `ReportPublicIssueInput`, `IssueService`
- `apps/api/src/issues/issues.controller.ts`: `IssueReportController`, `IssueQueueController`, `IssueTypeAdminController`
- `apps/api/src/issues/issues.module.ts`: `IssuesModule`

## `apps/api/src/jobs`

`JobsModule` in `apps/api/src/jobs/jobs.module.ts`, global. Import, move-out reminders and plugin installation all run as jobs, so the queue is provided globally like the other infrastructure modules.

- Providers: `JobQueueService`
- Exports: `JobQueueService`

Exports by file:

- `apps/api/src/jobs/job-queue.service.ts`: `JOB_SCHEMA`, `JobHandler`, `JobSendOptions`, `TransactionalSql`, `JobQueueService`
- `apps/api/src/jobs/jobs.module.ts`: `JobsModule`

## `apps/api/src/key-orders`

`KeyOrdersModule` in `apps/api/src/key-orders/key-orders.module.ts`. Key orders (nyckelbestallning): what a resident asks the association for, the queue the board works it from, and what becomes of the record that they asked.

- Controllers: `KeyOrderIntakeController`, `KeyOrderQueueController`
- Providers: `KeyOrderService`, `KeyOrderPurgeService`
- Exports: `KeyOrderService`

Exports by file:

- `apps/api/src/key-orders/key-order-purge.service.ts`: `KEY_ORDER_PURGE_QUEUE`, `KeyOrderPurgeRunSummary`, `KeyOrderPurgeService`
- `apps/api/src/key-orders/key-order-retention.ts`: `KEY_ORDER_RETENTION_DAYS`, `computeKeyOrderPurgeDate`, `keyOrderPurgeCutoff`
- `apps/api/src/key-orders/key-order.error.ts`: `KeyOrderTextLocation`, `KeyOrderError`
- `apps/api/src/key-orders/key-order.service.ts`: `KeyOrderApartmentView`, `OwnKeyOrderView`, `KeyOrdererView`, `QueuedKeyOrderView`, `KeyOrderIntakeView`, `KeyOrderQueueView`, `PlaceKeyOrderInput`, `ReviseKeyOrderInput`, `AnswerKeyOrderInput`, `KeyOrderService`
- `apps/api/src/key-orders/key-orders.controller.ts`: `KeyOrderIntakeController`, `KeyOrderQueueController`
- `apps/api/src/key-orders/key-orders.module.ts`: `KeyOrdersModule`

## `apps/api/src/logging`

Exports by file:

- `apps/api/src/logging/failure.ts`: `failureName`, `failureFrames`, `identifier`

## `apps/api/src/mail`

`MailModule` in `apps/api/src/mail/mail.module.ts`, global. Correspondence is infrastructure: invitations, sign-in links and the move flows all send mail, so the service is provided globally alongside the database, crypto, audit and translation modules.

- Providers: `MailSettingsResolver`, `MailService`
- Exports: `MailSettingsResolver`, `MailService`

Exports by file:

- `apps/api/src/mail/board-recipients.ts`: `activeBoardSeatWhere`, `holdsBoardSeat`, `activeBoardRecipientsWhere`
- `apps/api/src/mail/delivery-failure.ts`: `isDeliveryFailure`
- `apps/api/src/mail/header-text.ts`: `MAX_DISPLAY_NAME`, `CONTROL_CHARACTERS`, `hasControlCharacter`, `oneLine`, `INVISIBLE_CHARACTERS`, `hasInvisibleCharacter`, `withoutInvisibleCharacters`
- `apps/api/src/mail/http-api-mail.driver.ts`: `MailApiConfig`, `MailApiError`, `HttpApiMailDriver`
- `apps/api/src/mail/mail-driver.ts`: `MailDriverKind`, `OutgoingMail`, `SentMail`, `MailDriver`
- `apps/api/src/mail/mail-settings.ts`: `MailSource`, `EffectiveSmtpMail`, `EffectiveHttpApiMail`, `EffectiveMail`, `MailDescription`, `STORED_MAIL_COLUMNS`, `StoredMail`, `MailSettingsResolver`
- `apps/api/src/mail/mail-template.ts`: `MailBrand`, `MailTemplateContext`, `MailTemplate`, `RenderedMail`
- `apps/api/src/mail/mail.module.ts`: `MailModule`
- `apps/api/src/mail/mail.service.ts`: `MailNotConfiguredError`, `SendMailInput`, `MailService`
- `apps/api/src/mail/smtp-mail.driver.ts`: `defaultPortFor`, `MailTlsUnavailableError`, `MailServerNotPublicError`, `SmtpServer`, `SmtpMailDriver`
- `apps/api/src/mail/templates/board-mailbox-reply.template.tsx`: `BoardMailboxReplyMailProps`, `boardMailboxReplyMail`
- `apps/api/src/mail/templates/board-move-out-reminder.template.tsx`: `BoardMoveOutReminderMailProps`, `boardMoveOutReminderMail`
- `apps/api/src/mail/templates/booking-cancellation.template.tsx`: `BookingCancellationMailProps`, `bookingCancellationMail`
- `apps/api/src/mail/templates/booking-confirmation.template.tsx`: `BookingConfirmationMailProps`, `bookingConfirmationMail`
- `apps/api/src/mail/templates/booking-period.ts`: `BookingMailMode`, `BookingMailPeriod`, `bookingPeriodText`
- `apps/api/src/mail/templates/contact-submission.template.tsx`: `ContactSubmissionMailProps`, `contactSubmissionMail`
- `apps/api/src/mail/templates/invitation.template.tsx`: `InvitationMailProps`, `invitationMail`
- `apps/api/src/mail/templates/layout.tsx`: `MailLayoutProps`, `MailLayout`, `MailActionProps`, `MailAction`, `MAIL_COLORS`, `MAIL_FONT_STACK`
- `apps/api/src/mail/templates/magic-link-refused.template.tsx`: `MagicLinkRefusedMailProps`, `magicLinkRefusedMail`
- `apps/api/src/mail/templates/magic-link.template.tsx`: `MagicLinkMailProps`, `magicLinkMail`
- `apps/api/src/mail/templates/meeting-notice.template.tsx`: `MeetingNoticeMailKind`, `MeetingNoticeMailProps`, `meetingNoticeMail`
- `apps/api/src/mail/templates/move-in.template.tsx`: `MoveInMailProps`, `moveInMail`
- `apps/api/src/mail/templates/move-out.template.tsx`: `MoveOutMailProps`, `moveOutMail`
- `apps/api/src/mail/templates/news.template.tsx`: `NewsMailProps`, `newsMail`
- `apps/api/src/mail/templates/personal-data-breach-reminder.template.tsx`: `BreachReminderMailProps`, `breachReminderMail`
- `apps/api/src/mail/templates/register-report-obligation.template.tsx`: `RegisterReportObligationMailProps`, `registerReportObligationMail`
- `apps/api/src/mail/templates/smtp-test.template.tsx`: `SmtpTestMailProps`, `smtpTestMail`
- `apps/api/src/mail/testing/mail-api-test-server.ts`: `MailApiRequest`, `AcceptedMail`, `MailApiTestServer`, `startMailApiTestServer`

## `apps/api/src/management`

`ManagementModule` in `apps/api/src/management/management.module.ts`. The management API (ADR 0021): the listener whoever hosts the instance reads counts about it through, and the service that builds them.

- Imports: `PluginsModule`
- Providers: `ManagementSummaryService`, `ManagementListener`

Exports by file:

- `apps/api/src/management/board-activity.ts`: `runningTheAssociation`, `recordBoardActivity`
- `apps/api/src/management/management-listener.ts`: `MANAGEMENT_CALLS_PER_MINUTE`, `ManagementListener`
- `apps/api/src/management/management-summary.service.ts`: `ManagementSummaryService`
- `apps/api/src/management/management-summary.ts`: `ManagementSummary`, `MANAGEMENT_SUMMARY_SCHEMA`
- `apps/api/src/management/management-token.ts`: `presentedManagementToken`, `matchingManagementDigest`
- `apps/api/src/management/management.module.ts`: `ManagementModule`

## `apps/api/src/media`

`MediaModule` in `apps/api/src/media/media.module.ts`. Uploaded files: stored through one interface, encrypted at rest, served from this origin.

- Imports: `StorageModule`
- Controllers: `MediaController`
- Providers: `MediaService`, `StoredFileEncryptionService`
- Exports: `MediaService`

Exports by file:

- `apps/api/src/media/document-bytes.ts`: `DocumentHeader`, `readDocumentHeader`
- `apps/api/src/media/image-bytes.ts`: `ImageHeader`, `readImageHeader`
- `apps/api/src/media/image-metadata.ts`: `stripImageMetadata`
- `apps/api/src/media/media.controller.ts`: `MediaController`, `contentDisposition`
- `apps/api/src/media/media.module.ts`: `MediaModule`
- `apps/api/src/media/media.service.ts`: `MediaVisibility`, `isApartmentVisibility`, `MediaError`, `UploadInput`, `MediaFileView`, `ServedFile`, `mediaUrl`, `SealedForStorage`, `sealForStorage`, `unwrapFileKey`, `MediaService`, `RemovableFile`, `safeFileName`
- `apps/api/src/media/stored-file-encryption.service.ts`: `StoredFileEncryptionRun`, `StoredFileEncryptionError`, `StoredFileEncryptionService`
- `apps/api/src/media/testing/document-fixtures.ts`: `pdfBytes`, `truncatedPdfBytes`
- `apps/api/src/media/testing/image-fixtures.ts`: `pngChunk`, `pngBytes`, `jpegBytes`, `webpLossyBytes`, `webpLosslessBytes`, `gifBytes`, `GPS_MARKER`, `exifWithGps`, `jpegSegment`, `jpegMetadataSegments`

## `apps/api/src/meetings`

`MeetingsModule` in `apps/api/src/meetings/meetings.module.ts`. The general meeting (foreningsstamma): arranging one, its agenda, the notice that summons it, who was present and in what capacity, the proxy authorisations under which somebody else exercises a member's vote, and what the meeting decided.

- Controllers: `MeetingsController`
- Providers: `MeetingService`, `MeetingNoticeService`, `MeetingNoticeMailerService`
- Exports: `MeetingService`, `MeetingNoticeService`

Exports by file:

- `apps/api/src/meetings/agenda-lock.ts`: `lockMeetingAgenda`, `lockMeetingAgendasInOrder`
- `apps/api/src/meetings/meeting-bylaws.ts`: `MeetingBylaws`, `MIN_MEMBERS_PER_PROXY_HOLDER`, `MAX_MEMBERS_PER_PROXY_HOLDER`, `readMeetingBylaws`, `statutoryMeetingBylaws`, `isWritableProxyLimit`
- `apps/api/src/meetings/meeting-notice-delivery.ts`: `NOTICE_DELIVERY_FAILURES`, `MeetingNoticeDeliveryFailure`
- `apps/api/src/meetings/meeting-notice-mailer.service.ts`: `MEETING_NOTICE_QUEUE`, `MEETING_NOTICE_ABANDONED_QUEUE`, `MeetingNoticeMailerService`
- `apps/api/src/meetings/meeting-notice.service.ts`: `NoticeDeliveryReport`, `MeetingNoticeView`, `IssueNoticeInput`, `MeetingNoticeService`
- `apps/api/src/meetings/meeting.error.ts`: `MeetingError`
- `apps/api/src/meetings/meeting.service.ts`: `AgendaItemView`, `MeetingDecisionView`, `AttendanceView`, `ProxyAuthorisationView`, `MeetingSummaryView`, `MeetingView`, `ArrangeMeetingInput`, `SetAgendaInput`, `RecordAttendanceInput`, `RegisterProxyInput`, `RecordDecisionInput`, `MeetingService`
- `apps/api/src/meetings/meetings.controller.ts`: `MeetingsController`
- `apps/api/src/meetings/meetings.module.ts`: `MeetingsModule`
- `apps/api/src/meetings/proxy-authority.ts`: `proxyAuthorityRunsUntil`, `ProxyAuthorityProblem`, `proxyAuthorityProblem`, `isProxyAuthorityCurrent`
- `apps/api/src/meetings/proxy-lock.ts`: `lockProxyAuthorisations`
- `apps/api/src/meetings/voting-register.ts`: `VotingRegisterAttendance`, `VotingRegisterHolding`, `VotingRegisterProxyAuthorisation`, `VotingRegisterProxyHolder`, `VotingRegisterLine`, `VotingRegister`, `VotingRegisterInput`, `votingRegister`

## `apps/api/src/motions`

`MotionsModule` in `apps/api/src/motions/motions.module.ts`. Motions to the general meeting (motioner till stamman): what a member puts to the meeting, the queue the board works it from, and what becomes of the record that they put it.

- Imports: `ActionsModule`
- Controllers: `MotionIntakeController`, `MotionQueueController`
- Providers: `MotionService`, `MotionPurgeService`, `MotionActionsRegistrar`
- Exports: `MotionService`

Exports by file:

- `apps/api/src/motions/motion-actions.registrar.ts`: `MotionActionsRegistrar`
- `apps/api/src/motions/motion-deadline.ts`: `MotionDeadline`, `MotionDeadlineView`, `readMotionDeadline`, `nextMotionDeadline`, `motionDeadlineView`, `isWritableDeadline`
- `apps/api/src/motions/motion-purge.service.ts`: `MOTION_PURGE_QUEUE`, `MotionPurgeRunSummary`, `MotionPurgeService`
- `apps/api/src/motions/motion-retention.ts`: `MOTION_RETENTION_DAYS`, `computeMotionPurgeDate`, `motionPurgeCutoff`
- `apps/api/src/motions/motion.error.ts`: `MotionTextLocation`, `MotionError`
- `apps/api/src/motions/motion.service.ts`: `MotionMeetingView`, `OwnMotionView`, `MotionSubmitterView`, `QueuedMotionView`, `MotionIntakeView`, `MOTIONS_PER_PAGE`, `MotionQueueCursor`, `motionQueueCursor`, `parseMotionQueueCursor`, `MotionQueueView`, `SubmitMotionInput`, `MotionService`
- `apps/api/src/motions/motions.controller.ts`: `MotionIntakeController`, `MotionQueueController`
- `apps/api/src/motions/motions.module.ts`: `MotionsModule`

## `apps/api/src/moves`

`MovesModule` in `apps/api/src/moves/moves.module.ts`. Move-in and move-out.

- Imports: `RegistersModule`, `DataProtectionModule`
- Controllers: `MoveController`
- Providers: `MoveService`
- Exports: `MoveService`

Exports by file:

- `apps/api/src/moves/move.controller.ts`: `MoveController`
- `apps/api/src/moves/move.service.ts`: `MoveError`, `TransferInput`, `MoveInInput`, `MoveInResult`, `MoveOutInput`, `MoveOutResult`, `BoardReminderJob`, `MOVE_OUT_REMINDER_QUEUE`, `MoveService`
- `apps/api/src/moves/moves.module.ts`: `MovesModule`

## `apps/api/src/network`

Exports by file:

- `apps/api/src/network/outbound-address.ts`: `isPublicAddress`, `ResolvedAddress`, `ResolveAddresses`, `resolveAddresses`, `OutboundAddressCode`, `OutboundAddressError`, `resolvePublicAddresses`, `pinnedLookup`

## `apps/api/src/news`

`NewsModule` in `apps/api/src/news/news.module.ts`. The association's news: writing it, publishing it, sending it to the members by email and by text message, reading it inside the application, and the comments the members write back.

- Imports: `ActionsModule`
- Controllers: `NewsAdminController`, `NewsReaderController`, `NewsCommentController`, `NewsCommentModerationController`
- Providers: `NewsWriteService`, `NewsMailerService`, `NewsSmsService`, `NewsCommentService`, `NewsActionsRegistrar`, `NewsCommentActionsRegistrar`
- Exports: `NewsWriteService`, `NewsMailerService`, `NewsSmsService`, `NewsCommentService`

Exports by file:

- `apps/api/src/news/news-actions.registrar.ts`: `NewsActionsRegistrar`
- `apps/api/src/news/news-admin.controller.ts`: `NewsAdminController`
- `apps/api/src/news/news-comment-actions.registrar.ts`: `NewsCommentActionsRegistrar`
- `apps/api/src/news/news-comment.controller.ts`: `NewsCommentController`, `NewsCommentModerationController`
- `apps/api/src/news/news-comment.error.ts`: `NewsCommentTextLocation`, `NewsCommentError`
- `apps/api/src/news/news-comment.service.ts`: `NEWS_COMMENT_MAX_LENGTH`, `COMMENTS_PER_PAGE`, `ThreadCursor`, `threadCursor`, `parseThreadCursor`, `ThreadReader`, `NewsCommentPage`, `NewsCommentAuthorView`, `NewsCommentView`, `NewsArticleView`, `WriteNewsCommentInput`, `NewsCommentService`, `olderThan`, `refusePersonalIdentityNumbers`
- `apps/api/src/news/news-delivery.ts`: `DELIVERY_FAILURES`, `NewsDeliveryFailure`, `objectionStands`
- `apps/api/src/news/news-mailer.service.ts`: `NEWS_MAILING_QUEUE`, `NEWS_MAILING_ABANDONED_QUEUE`, `NewsMailerService`
- `apps/api/src/news/news-reader.controller.ts`: `NewsReaderController`
- `apps/api/src/news/news-sms-message.ts`: `MAX_SMS_CHARACTERS`, `NewsSmsInput`, `composeNewsSms`
- `apps/api/src/news/news-sms.service.ts`: `NEWS_SMS_QUEUE`, `NEWS_SMS_ABANDONED_QUEUE`, `NewsSmsService`
- `apps/api/src/news/news-write.service.ts`: `NewsTextLocation`, `NewsWriteReason`, `NewsWriteError`, `NewsDeliveryReport`, `NewsMailingReport`, `NewsAdminView`, `NewsInput`, `UpdateNewsInput`, `CreateNewsInput`, `PublishNewsInput`, `NewsSummary`, `PublishNewsResult`, `NewsWriteService`, `recipientsWhere`
- `apps/api/src/news/news.module.ts`: `NewsModule`

## `apps/api/src/packaging`

`PackagingModule` in `apps/api/src/packaging/packaging.module.ts`, global. Package distribution, shared by plugins and themes.

- Providers: `CatalogClient`, `PackageLock`
- Exports: `CatalogClient`, `PackageLock`

Exports by file:

- `apps/api/src/packaging/archive-package-json.ts`: `readArchivePackageJson`
- `apps/api/src/packaging/catalog-entry.ts`: `CatalogError`, `parseCatalog`
- `apps/api/src/packaging/catalog.client.ts`: `CURATED_CATALOG_URL`, `INDEX_TIMEOUT_MS`, `CatalogClient`
- `apps/api/src/packaging/data-paths.ts`: `DataPaths`, `dataPaths`
- `apps/api/src/packaging/fetch-resource.ts`: `ResourceFetchDetail`, `ResourceFetchError`, `FetchOptions`, `DEFAULT_MAX_BYTES`, `fetchBytes`
- `apps/api/src/packaging/integrity.ts`: `sha512`, `verifySha512`
- `apps/api/src/packaging/npm-install.ts`: `NpmInstallError`, `NpmInstallOptions`, `npmInstall`, `npmAvailable`
- `apps/api/src/packaging/package-archive.ts`: `archiveFileName`, `ArchiveStoreOptions`, `ensureArchive`, `fetchVerified`
- `apps/api/src/packaging/package-lock.ts`: `PACKAGE_LOCK_WAIT_MS`, `PACKAGE_LOCK_CONNECT_MS`, `MAX_PACKAGE_OPERATIONS`, `PACKAGE_BUSY_RETRY_AFTER_SECONDS`, `PackageKind`, `PackageLockLimits`, `PACKAGE_LOCK_LIMITS`, `PackageBusyError`, `PackageLockLostError`, `PACKAGE_LOCK_APPLICATION_NAME`, `PackageLock`
- `apps/api/src/packaging/packaging.module.ts`: `PackagingModule`

## `apps/api/src/plugins`

`PluginsModule` in `apps/api/src/plugins/plugins.module.ts`. The plugin system.

- Imports: `ActionsModule`, `PackagingModule`, `DataProtectionModule`, `SiteBlocksModule`
- Controllers: `PluginsReadController`, `PluginsWriteController`, `PluginViewsController`, `PluginI18nController`, `PluginAssetController`
- Providers: `PLUGIN_BOOT`, `PluginHostBinding`, `PluginRegistryService`, `PluginAddressBookService`, `PluginHostBinder`, `PluginLoaderService`, `PluginInstallerService`, `PluginAdminService`, `RestartCoordinator`, `PluginServingGuard`, `PluginServingGuard as APP_GUARD`, `PluginErrorInterceptor`, `PluginErrorInterceptor as APP_INTERCEPTOR`
- Exports: `PluginAdminService`, `PluginHostBinder`, `PluginLoaderService`, `PluginRegistryService`, `RestartCoordinator`

Exports by file:

- `apps/api/src/plugins/install-lock.ts`: `INSTALL_LOCK_FILE`, `InstallLockError`, `InstallLock`, `AcquireInstallLockOptions`, `acquireInstallLock`
- `apps/api/src/plugins/plugin-action-gate.ts`: `canonicalAction`, `sameActionDeclaration`, `ActionGateRefusal`, `checkDeclaredActions`
- `apps/api/src/plugins/plugin-address-book.service.ts`: `PluginAddressBookService`
- `apps/api/src/plugins/plugin-admin.service.ts`: `PluginSummary`, `PluginsOverview`, `PluginViewDescriptor`, `CatalogPluginView`, `PluginSettingsView`, `InstallRequest`, `PluginAdminService`
- `apps/api/src/plugins/plugin-asset.controller.ts`: `PluginAssetController`
- `apps/api/src/plugins/plugin-boot.ts`: `BootPlugin`, `PluginFinding`, `PluginBoot`, `emptyPluginBoot`, `setPluginBoot`, `pluginBoot`, `readPluginRecords`, `LoadPluginsOptions`, `loadPlugins`
- `apps/api/src/plugins/plugin-directory.ts`: `DiscoveredPlugin`, `SkipReason`, `SkippedPlugin`, `DirectoryScan`, `pluginModulesDirectory`, `scanPluginDirectory`, `readPluginDirectory`
- `apps/api/src/plugins/plugin-error.interceptor.ts`: `PluginErrorInterceptor`
- `apps/api/src/plugins/plugin-host.binder.ts`: `PluginHostBinder`
- `apps/api/src/plugins/plugin-host.ts`: `PluginHostServices`, `PluginHostBinding`, `pluginHostBinding`, `PluginHostContext`, `createPluginHost`, `routeCapabilityFloor`
- `apps/api/src/plugins/plugin-i18n.controller.ts`: `PluginI18nController`
- `apps/api/src/plugins/plugin-install-failure.ts`: `PluginInstallFailure`, `PluginInstallError`, `PluginInstallPhase`, `pluginInstallFailure`
- `apps/api/src/plugins/plugin-installer.service.ts`: `PLUGIN_INSTALL_QUEUE`, `ARCHIVE_TIMEOUT_MS`, `FETCH_BUDGET_MS`, `PluginInstallJob`, `ReconcileOutcome`, `PluginInstallerService`, `buildDependencySet`, `ConsentedRelease`, `assertArchivedPackages`, `assertStagedPackages`, `collectAbandonedStaging`
- `apps/api/src/plugins/plugin-labels.ts`: `PERMISSION_LABEL_KEYS`, `PERSONAL_DATA_LABEL_KEYS`, `permissionLabelKey`, `personalDataLabelKey`, `INSTALL_FAILURE_LABEL_KEYS`, `installFailureLabelKey`
- `apps/api/src/plugins/plugin-loader.service.ts`: `LoadedPlugin`, `PLUGIN_BOOT`, `PluginLoaderService`
- `apps/api/src/plugins/plugin-mail.template.tsx`: `PluginMailProps`, `pluginMail`
- `apps/api/src/plugins/plugin-module-seal.ts`: `PLUGIN_ID_METADATA`, `DeniedInjection`, `DENIED_INJECTIONS`, `ALLOWED_INJECTIONS`, `SealOptions`, `SealResult`, `sealPluginModule`, `CheckedRoute`, `FixedController`, `fixedController`, `checkedRoute`, `rereadSealedModule`, `BuiltModule`, `BuiltInstance`, `sealModuleInstances`, `declaredModules`, `hostModules`
- `apps/api/src/plugins/plugin-registry.service.ts`: `PluginRecord`, `PluginRelease`, `PluginConsent`, `PluginRegistryService`
- `apps/api/src/plugins/plugin-resolution.ts`: `hostModulesDirectories`, `hostModulesDirectory`, `bridgeHostResolution`, `requirePluginBundle`, `ResolutionConflict`, `findResolutionConflicts`
- `apps/api/src/plugins/plugin-serving.guard.ts`: `PluginServingGuard`
- `apps/api/src/plugins/plugin-view-offer.ts`: `offeredSection`
- `apps/api/src/plugins/plugin.errors.ts`: `PluginNotFoundError`, `CatalogEntryNotFoundError`, `PluginApiVersionError`, `PluginEntryDeprecatedError`, `PluginResourceConflictError`, `PluginReservedIdError`, `PluginConsentMismatchError`, `PluginRecipientRequiredError`, `PluginRecipientAlreadyRecordedError`, `PluginsDisabledError`, `PluginRouteNotFoundError`, `PluginHandlerError`, `PluginSettingsUnavailableError`
- `apps/api/src/plugins/plugins.controller.ts`: `PluginsReadController`, `PluginViewsController`, `PluginsWriteController`
- `apps/api/src/plugins/plugins.module.ts`: `PluginsModule`
- `apps/api/src/plugins/restart-coordinator.service.ts`: `ClosableApplication`, `DRAIN_TIMEOUT_MS`, `RestartCoordinator`, `DrainOutcome`, `drain`

## `apps/api/src/registers`

`RegistersModule` in `apps/api/src/registers/registers.module.ts`. The two statutory registers, and what the association owes the third.

- Controllers: `MemberRegisterController`, `ApartmentRegisterController`, `OwnApartmentRegisterController`, `RegisterReportController`, `InitialSupplyController`
- Providers: `MemberRegisterService`, `ApartmentRegisterService`, `RegisterReportService`, `RegisterReportMailerService`, `InitialSupplyService`, `MemberRegisterReconciliationService`
- Exports: `MemberRegisterService`, `ApartmentRegisterService`

Exports by file:

- `apps/api/src/registers/acting-person.ts`: `actingPersonId`
- `apps/api/src/registers/apartment-order.ts`: `APARTMENT_REGISTER_ORDER`
- `apps/api/src/registers/apartment-register.controller.ts`: `ApartmentRegisterController`, `OwnApartmentRegisterController`
- `apps/api/src/registers/apartment-register.service.ts`: `ApartmentRegisterErrorReason`, `ApartmentRegisterError`, `RegisterIdentityNumber`, `ApartmentRegisterHolder`, `ApartmentRegisterLien`, `ApartmentRegisterTransfer`, `ApartmentRegisterTermination`, `ApartmentRegisterTransferReversal`, `ApartmentRegisterRow`, `ApartmentRegisterExtract`, `ApartmentRegisterQuery`, `ApartmentRegisterService`
- `apps/api/src/registers/held-on.ts`: `residencyHeldOn`, `boardSeatHeldOn`, `boardSeatNotEndedOn`, `isBoardSeatHeldOn`, `hasMovedOut`, `isResidencyHeldOn`
- `apps/api/src/registers/initial-supply-file.ts`: `SupplyRecordType`, `SUPPLY_COLUMNS`, `SupplyColumn`, `SupplyRow`, `supplyFileName`, `writeSupplyFile`
- `apps/api/src/registers/initial-supply.service.ts`: `InitialSupplyErrorReason`, `InitialSupplyError`, `InitialSupply`, `InitialSupplyService`
- `apps/api/src/registers/member-register-reconciliation.ts`: `RECONCILIATION_NOTE`, `PersonReconciliation`, `reconcileMembership`, `ReconciliationReport`, `MemberRegisterReconciliationService`, `describeOwed`
- `apps/api/src/registers/member-register.controller.ts`: `MemberRegisterController`
- `apps/api/src/registers/member-register.service.ts`: `RegisterPostalAddress`, `MemberRegisterApartment`, `MemberRegisterRow`, `MemberRegisterScope`, `MemberRegisterExtract`, `MemberRegisterService`
- `apps/api/src/registers/membership-periods.ts`: `MemberRegisterEventType`, `MemberRegisterEvent`, `MemberRegisterArchiveRow`, `ResolvedRegisterEvent`, `MembershipPeriod`, `resolveRegisterEvents`, `membershipPeriods`, `isCurrentMembership`, `recordedAt`
- `apps/api/src/registers/membership-transitions.ts`: `MemberResidencySpan`, `OwedMembershipEvent`, `owedMembershipEvents`, `readMemberResidencies`, `appendOwedMembershipEvents`
- `apps/api/src/registers/register-report-mailer.service.ts`: `RegisterReportNoticeJob`, `REGISTER_REPORT_NOTICE_QUEUE`, `RegisterReportMailerService`
- `apps/api/src/registers/register-report.controller.ts`: `RegisterReportController`, `InitialSupplyController`
- `apps/api/src/registers/register-report.service.ts`: `RegisterReportErrorReason`, `RegisterReportError`, `RegisterReportDuty`, `RegisterReportElsewhere`, `RegisterReportQueue`, `RegisterReportService`
- `apps/api/src/registers/registers.module.ts`: `RegistersModule`
- `apps/api/src/registers/report-deadline.ts`: `REPORT_WINDOW_DAYS`, `reportDueOn`
- `apps/api/src/registers/report-state.ts`: `ReportState`, `reportState`, `daysUntilDue`, `compareByDeadline`
- `apps/api/src/registers/residency-lock.ts`: `lockResidencyTransitions`, `lockResidencyTransitionsInOrder`, `lockApartmentResidencies`, `lockApartmentResidenciesInOrder`, `residentsOf`
- `apps/api/src/registers/statutory-date.ts`: `StatutoryDateProblem`, `StatutoryDate`, `statutoryDate`

## `apps/api/src/retention`

`RetentionModule` in `apps/api/src/retention/retention.module.ts`. Retention: the promise, the exception to it, and the answer to a person who asks what is held about them.

- Controllers: `LegalHoldController`, `DataSubjectReportController`
- Providers: `LegalHoldService`, `PurgeService`, `DataSubjectReportService`
- Exports: `LegalHoldService`, `PurgeService`, `DataSubjectReportService`

Exports by file:

- `apps/api/src/retention/connected-app-token-sweep.ts`: `ConnectedAppTokenSweepOutcome`, `sweepConnectedAppTokens`
- `apps/api/src/retention/data-subject-report.controller.ts`: `DataSubjectReportController`
- `apps/api/src/retention/data-subject-report.service.ts`: `DataSubjectReportError`, `DataSubjectReportService`, `overlapsResidency`
- `apps/api/src/retention/data-subject-report.ts`: `ReportPostalAddress`, `ReportPerson`, `ReportResidency`, `ReportBoardPosition`, `ReportAccount`, `ReportPasskey`, `ReportSignInSession`, `ReportInvitation`, `ReportConnectedAppScope`, `ReportConnectedApp`, `ReportDataSubjectRequest`, `ReportPersonalDataBreach`, `ReportMemberRegisterEntry`, `ReportTransfer`, `ReportTransferReversal`, `ReportTermination`, `ReportRegisterReportObligation`, `ReportPublicationConsent`, `ReportIssue`, `ReportDocument`, `ReportApartmentDocument`, `ReportBooking`, `ReportMotion`, `ReportEventSignup`, `ReportMemberCharge`, `ReportFee`, `ReportFeeNotice`, `ReportBoardMailboxThread`, `ReportBoardMailboxMessage`, `ReportComment`, `ReportNewsDelivery`, `ReportAudience`, `ReportPostReport`, `ReportPost`, `ReportMeetingAttendance`, `ReportProxyAuthorisation`, `ReportMeetingNoticeDelivery`, `ReportLienNote`, `ReportAuditEntry`, `ReportSubletApplication`, `ReportKeyOrder`, `DataSubjectReport`
- `apps/api/src/retention/erasure-domains.ts`: `ErasureDbClient`, `ErasurePersonFilter`, `bookingsErasedOnRequest`, `feedErasedOnRequest`, `eventSignupsErasedOnRequest`, `MOTIONS_OFF_AGENDAS_TO_COME`, `motionsErasedOnRequest`, `motionsKeptFromErasure`, `boardMailboxThreadsErasedOnRequest`, `boardMailboxThreadsKeptFromErasure`, `boardMailboxWithheldAddresses`, `feedTracesErasedOnRequest`, `keyOrdersErasedOnRequest`, `keyOrdersKeptFromErasure`, `subletApplicationsErasedOnRequest`, `subletApplicationsKeptFromErasure`, `lastDayOfRunningConsentedLetting`, `ErasureDomainKey`, `ErasureDomain`, `ERASURE_DOMAINS`, `ErasureRemainder`, `erasureDomainKey`, `erasureRemainder`, `describeRemainder`, `remainingRunBound`
- `apps/api/src/retention/erasure-lock.ts`: `lockErasureEligibility`
- `apps/api/src/retention/erasure-waiting-on.ts`: `ErasureRequestStatus`, `ErasureWaitingOn`, `erasureWaitingOn`, `erasureRequestStatus`
- `apps/api/src/retention/export-slots.ts`: `MAX_CONCURRENT_EXPORTS`, `BUSY_RETRY_AFTER_SECONDS`, `ExportsBusyError`, `ExportSlots`
- `apps/api/src/retention/financial-year.ts`: `CALENDAR_YEAR_START_MONTH`, `FINANCIAL_YEAR_START_MONTHS`, `financialYearStartMonthInForce`, `financialYearEndYearOfColumn`, `financialYearStartColumn`, `preservationEndOf`, `preservationCutoff`, `assertStartMonth`
- `apps/api/src/retention/holding-periods.ts`: `HoldingPeriod`, `DatedLienNote`, `DatedTermination`, `holdingPeriods`, `lienNotesDuringHolding`, `terminationsDuringHolding`
- `apps/api/src/retention/legal-hold-lock.ts`: `lockLegalHold`, `lockLegalHoldRegistry`
- `apps/api/src/retention/legal-hold.controller.ts`: `LegalHoldController`
- `apps/api/src/retention/legal-hold.service.ts`: `LegalHoldError`, `LegalHoldView`, `LegalHoldService`
- `apps/api/src/retention/purge-date.ts`: `computePurgeDate`, `PersonPurgeFacts`, `computePersonPurgeDate`
- `apps/api/src/retention/purge-refusal.ts`: `PurgeRefusal`, `RequestPurgeRefusal`, `PurgeRefusalFacts`, `purgeRefusal`, `purgeRefusalOnRequest`, `describePurgeRefusal`
- `apps/api/src/retention/purge-window.ts`: `purgeCutoff`
- `apps/api/src/retention/purge.service.ts`: `SERVICE_DATA_PURGE_QUEUE`, `PurgeOutcome`, `OpenErasureRequest`, `PurgeRunSummary`, `PurgeService`
- `apps/api/src/retention/report-audit-actions.ts`: `REPORT_AUDIT_ACTIONS`, `ReportAuditAction`
- `apps/api/src/retention/retention-policy.ts`: `DEFAULT_RETENTION_DAYS_AFTER_MOVE_OUT`, `retentionDaysAfterMoveOut`
- `apps/api/src/retention/retention.module.ts`: `RetentionModule`
- `apps/api/src/retention/sign-in-session-sweep.ts`: `sweepExpiredSignInSessions`
- `apps/api/src/retention/withheld-addresses.ts`: `withheldAddressIndexes`
- `apps/api/src/retention/withheld-persons.ts`: `withheldPersonIds`, `isPersonWithheld`, `isAnyPersonWithheld`, `erasureRequestedPersonIds`, `isErasureInForce`, `grantedErasurePersonIds`

## `apps/api/src/roles`

`RolesModule` in `apps/api/src/roles/roles.module.ts`. Conferring and revoking a role.

- Controllers: `BoardPositionController`, `SystemRoleController`
- Providers: `BoardPositionService`, `SystemRoleService`
- Exports: `BoardPositionService`, `SystemRoleService`

Exports by file:

- `apps/api/src/roles/board-position.service.ts`: `ElectInput`, `RecoveredSeat`, `RecoverBoardInput`, `EndTermInput`, `BoardPositionService`
- `apps/api/src/roles/role-changes.ts`: `RoleChangeReason`, `RoleChangeError`, `BoardPositionView`, `SystemRoleGrantsView`, `hasTermEnded`, `earliestElection`, `latestTermEnd`, `latestElection`, `TermEndRefusal`, `refuseTermEnd`, `overlapsRecordedTerm`, `revokingWouldLeaveNoAdministrator`, `parseCalendarDate`
- `apps/api/src/roles/role-lock.ts`: `lockBoardPositions`, `lockSystemRole`, `lockBoardRegister`
- `apps/api/src/roles/role.controller.ts`: `BoardPositionController`, `SystemRoleController`
- `apps/api/src/roles/roles.module.ts`: `RolesModule`
- `apps/api/src/roles/system-role.service.ts`: `SetSystemRoleInput`, `SystemRoleService`

## `apps/api/src/seed`

Exports by file:

- `apps/api/src/seed/demo-data.ts`: `DemoBuilding`, `DEMO_ASSOCIATION`, `DEMO_BUILDINGS`, `DEMO_FLOOR_WEIGHTS`, `DEMO_TOTAL_INITIAL_SHARE_CAPITAL`, `DemoRole`, `DemoBoardPosition`, `DemoPerson`, `DEMO_PEOPLE`, `DEMO_PERSON_COUNT`, `FILLER_FIRST_NAMES`, `FILLER_LAST_NAMES`
- `apps/api/src/seed/seed.ts`: `SeedResult`, `DEMO_SEED_FLAG`, `demoSeedRefusal`, `seedDemoData`

## `apps/api/src/settings`

`SettingsModule` in `apps/api/src/settings/settings.module.ts`.

- Imports: `MediaModule`
- Controllers: `SettingsReadController`, `SettingsWriteController`, `ProfileSettingsController`
- Providers: `SettingsService`
- Exports: `SettingsService`

Exports by file:

- `apps/api/src/settings/retention-lock.ts`: `lockRetentionPolicy`
- `apps/api/src/settings/settings.controller.ts`: `SettingsReadController`, `SettingsWriteController`, `ProfileSettingsController`
- `apps/api/src/settings/settings.module.ts`: `SettingsModule`
- `apps/api/src/settings/settings.service.ts`: `ContrastFailure`, `SettingsError`, `FinanceSettings`, `HousingCooperativeSettings`, `LogoView`, `LogoSlot`, `BrandingSettings`, `SmtpSettingsView`, `StoredSmtpSettingsView`, `EnvironmentMailView`, `BoardMailboxSettingsView`, `BoardMailboxInput`, `SmsSettingsView`, `DataProtectionContacts`, `InstanceSettings`, `HousingCooperativeInput`, `SmtpInput`, `SmsInput`, `SettingsService`

## `apps/api/src/setup`

`SetupModule` in `apps/api/src/setup/setup.module.ts`.

- Imports: `PagesModule`, `DataProtectionModule`
- Controllers: `SetupController`, `SetupCompletionController`
- Providers: `SetupService`, `SetupClaimService`
- Exports: `SetupService`

Exports by file:

- `apps/api/src/setup/setup-claim.service.ts`: `ClaimSource`, `SetupClaimService`
- `apps/api/src/setup/setup.controller.ts`: `SetupController`, `SetupCompletionController`
- `apps/api/src/setup/setup.module.ts`: `SetupModule`
- `apps/api/src/setup/setup.service.ts`: `SetupError`, `SetupState`, `CreateFirstAdministratorInput`, `SetupService`

## `apps/api/src/signup`

`SignupModule` in `apps/api/src/signup/signup.module.ts`.

- Imports: `InvitationsModule`, `MovesModule`
- Controllers: `SignupRequestSubmitController`, `SignupRequestStateController`, `SignupRequestController`
- Providers: `SignupRequestService`
- Exports: `SignupRequestService`

Exports by file:

- `apps/api/src/signup/signup-request.controller.ts`: `SignupRequestSubmitController`, `SignupRequestStateController`, `SignupRequestController`
- `apps/api/src/signup/signup-request.service.ts`: `SignupRequestError`, `SubmitSignupRequestInput`, `SignupRequestService`
- `apps/api/src/signup/signup.module.ts`: `SignupModule`

## `apps/api/src/site`

`PagesModule` in `apps/api/src/site/pages.module.ts`. The association's pages, as storage.

- Providers: `MenuService`, `PagesService`
- Exports: `MenuService`, `PagesService`

`SiteBlocksModule` in `apps/api/src/site/site-blocks.module.ts`. The website's block types, as a module of its own.

- Providers: `SiteBlocksService`
- Exports: `SiteBlocksService`

`SiteModule` in `apps/api/src/site/site.module.ts`. The public website.

- Imports: `PagesModule`, `SetupModule`, `ThemesModule`, `MediaModule`, `IssuesModule`, `ContactModule`, `DocumentsModule`, `BoardModule`, `ActionsModule`, `SiteBlocksModule`
- Controllers: `SiteNewsController`, `SiteCalendarController`, `SiteController`, `SiteFormsController`, `PagesAdminController`, `SiteImagesController`, `SiteBlocksAdminController`, `MenuAdminController`, `AssociationFactsController`
- Providers: `SiteRenderer`, `SiteNewsService`, `SiteEventsService`, `PagesWriteService`, `MenuWriteService`, `AssociationFactsService`, `AssociationFactsActionsRegistrar`, `SiteActionsRegistrar`
- Exports: `SiteRenderer`

Exports by file:

- `apps/api/src/site/association-facts-actions.registrar.ts`: `AssociationFactsActionsRegistrar`
- `apps/api/src/site/association-facts.controller.ts`: `AssociationFactsController`
- `apps/api/src/site/association-facts.service.ts`: `FACT_TEXT_FIELDS`, `FactTextField`, `FACT_FLAG_FIELDS`, `FactFlagField`, `AssociationFactsView`, `AssociationFactsInput`, `FactTextLocation`, `AssociationFactsReason`, `AssociationFactsError`, `AssociationFactsService`
- `apps/api/src/site/menu-admin.controller.ts`: `MenuAdminController`
- `apps/api/src/site/menu-lock.ts`: `lockMenu`
- `apps/api/src/site/menu-write.service.ts`: `MenuWriteReason`, `MenuWriteError`, `MenuItemView`, `MenuItemInput`, `MenuWriteService`
- `apps/api/src/site/menu.service.ts`: `MenuGeneratedKey`, `MENU_GENERATED_KEYS`, `isMenuGeneratedKey`, `MenuAudience`, `SiteMenuLink`, `SiteMenuEntry`, `SiteMenu`, `isMenuExternalUrl`, `MenuService`
- `apps/api/src/site/page-content.ts`: `PageContent`, `PAGE_CONTENT_VERSION`, `submittedContentSchema`, `ContentSchema`, `contentSchemaFor`, `registeredBlockSchema`, `proseBlockSchema`, `submittedContent`, `isTextBlock`, `textBlocksOnly`, `paragraphsContent`, `readPageContent`, `PageTextPart`, `pageTextParts`, `hasBlock`, `imageReferences`, `linkedPageIds`
- `apps/api/src/site/page-order-lock.ts`: `lockPageOrder`
- `apps/api/src/site/pages-admin.controller.ts`: `PagesAdminController`, `SiteBlocksAdminController`, `SiteImagesController`
- `apps/api/src/site/pages-write.service.ts`: `PageTextLocation`, `identityNumbersInBody`, `PageWriteError`, `PageSummary`, `PageAdminView`, `CreatePageInput`, `UpdatePageInput`, `PagesWriteService`
- `apps/api/src/site/pages.module.ts`: `PagesModule`
- `apps/api/src/site/pages.service.ts`: `PRIVACY_NOTICE_SECTIONS`, `PrivacyNoticeSection`, `SitePage`, `isSlugShaped`, `isUsableSlug`, `PRIVACY_NOTICE_SLUG`, `PagesService`
- `apps/api/src/site/plugin-block-output.ts`: `SiteBlockNode`, `SiteBlockElement`, `PluginBlockRefusal`, `PluginBlockOutput`, `PLUGIN_BLOCK_OUTPUT_LIMITS`, `readPluginBlockOutput`
- `apps/api/src/site/site-actions.registrar.ts`: `SiteActionsRegistrar`
- `apps/api/src/site/site-blocks.module.ts`: `SiteBlocksModule`
- `apps/api/src/site/site-blocks.service.ts`: `RegisteredSiteBlock`, `SiteBlockRenderContext`, `SiteBlocksService`
- `apps/api/src/site/site-broker.tsx`: `BrokerPageInput`, `renderBrokerPage`
- `apps/api/src/site/site-calendar.controller.ts`: `SiteCalendarController`
- `apps/api/src/site/site-calendar.tsx`: `renderCalendarPage`, `renderEventPage`
- `apps/api/src/site/site-css.ts`: `buildSiteStylesheet`
- `apps/api/src/site/site-events.service.ts`: `SiteEventDate`, `SiteEvent`, `CalendarMonth`, `SiteCalendarPage`, `CALENDAR_MONTH_PARAM`, `parseCalendarMonth`, `formatCalendarMonth`, `calendarMonthOf`, `shiftCalendarMonth`, `clampCalendarMonth`, `SiteEventsService`
- `apps/api/src/site/site-facts.tsx`: `BrokerPageInput`, `FactGroup`, `associationFactGroups`, `hasRecordedFacts`, `renderFactGroups`
- `apps/api/src/site/site-forms.controller.ts`: `LineBreaksAsOne`, `SiteFormsController`
- `apps/api/src/site/site-forms.tsx`: `SiteFormKind`, `SITE_FORM_PATH`, `SITE_FORM_SENT_PARAM`, `SITE_FORM_REFUSED_PARAM`, `siteFormKind`, `SiteIssueType`, `SiteFormState`, `renderSiteForm`
- `apps/api/src/site/site-html.tsx`: `SiteChrome`, `SiteControllerContact`, `SiteDocument`, `NewsTeaser`, `BROKER_PATH`, `CALENDAR_PATH`, `NEWS_PATH`, `newsPath`, `eventPath`, `calendarMonthPath`, `formatNewsDate`, `formatEventDate`, `formatEventTime`, `formatCalendarMonthName`, `renderPage`, `renderNotFound`, `renderBlock`, `renderEventDates`, `isoDate`, `renderRuns`, `renderDocument`
- `apps/api/src/site/site-news.controller.ts`: `SiteNewsController`
- `apps/api/src/site/site-news.service.ts`: `SiteNewsArticle`, `NEWS_INDEX_PAGE_SIZE`, `NEWS_PAGE_PARAM`, `SiteNewsIndexPage`, `SiteNewsService`, `teaserOf`
- `apps/api/src/site/site-news.tsx`: `renderNewsIndex`, `renderNewsArticle`
- `apps/api/src/site/site-paths.ts`: `NEWS_PATH`, `CALENDAR_PATH`, `BROKER_PATH`
- `apps/api/src/site/site-renderer.service.ts`: `SITE_HTML_HEADERS`, `SiteSubmissionState`, `SiteVisit`, `SiteRenderer`
- `apps/api/src/site/site-request.ts`: `acceptLanguage`, `queryValue`, `hasSession`, `sessionPersonId`
- `apps/api/src/site/site.controller.ts`: `SiteController`
- `apps/api/src/site/site.module.ts`: `SiteModule`
- `apps/api/src/site/visitor-locale.ts`: `visitorLocale`

## `apps/api/src/sms`

`SmsModule` in `apps/api/src/sms/sms.module.ts`, global. Text messaging, behind one interface and whichever driver the board configured.

- Providers: `SmsService`
- Exports: `SmsService`

Exports by file:

- `apps/api/src/sms/http-gateway.driver.ts`: `HttpGatewayConfig`, `HttpGatewaySmsDriver`
- `apps/api/src/sms/no-provider.driver.ts`: `NoSmsProviderDriver`
- `apps/api/src/sms/sms.driver.ts`: `SmsDriverKind`, `SmsMessage`, `SmsDriver`, `SmsNotConfiguredError`, `SmsError`
- `apps/api/src/sms/sms.module.ts`: `SmsModule`
- `apps/api/src/sms/sms.service.ts`: `SmsSettings`, `selectedDriverKind`, `createDriver`, `SmsService`
- `apps/api/src/sms/testing/recording.driver.ts`: `RecordingSmsDriver`
- `apps/api/src/sms/testing/sms-gateway-test-server.ts`: `SmsGatewayTestServer`, `startSmsGatewayTestServer`

## `apps/api/src/storage`

`StorageModule` in `apps/api/src/storage/storage.module.ts`. File storage, behind one interface and two drivers.

- Providers: `StorageService`
- Exports: `StorageService`

Exports by file:

- `apps/api/src/storage/local-disk.driver.ts`: `LocalDiskStorageDriver`
- `apps/api/src/storage/s3.driver.ts`: `S3StorageConfig`, `S3StorageDriver`
- `apps/api/src/storage/storage-key.ts`: `StoragePrefix`, `generateStorageKey`
- `apps/api/src/storage/storage.driver.ts`: `StorageDriver`, `StorageError`
- `apps/api/src/storage/storage.module.ts`: `StorageModule`
- `apps/api/src/storage/storage.service.ts`: `StorageService`, `createDriver`
- `apps/api/src/storage/testing/s3-test-server.ts`: `S3TestServer`, `startS3TestServer`

## `apps/api/src/sublets`

`SubletsModule` in `apps/api/src/sublets/sublets.module.ts`. Subletting applications (andrahandsupplatelse): what a member asks the board's consent for, the queue the board answers it from, and what becomes of the record that they asked.

- Controllers: `SubletIntakeController`, `SubletQueueController`
- Providers: `SubletService`, `SubletPurgeService`
- Exports: `SubletService`

Exports by file:

- `apps/api/src/sublets/sublet-purge.service.ts`: `SUBLET_PURGE_QUEUE`, `SubletPurgeRunSummary`, `SubletPurgeService`
- `apps/api/src/sublets/sublet-retention.ts`: `SUBLET_RETENTION_DAYS`, `SubletPurgeCutoffs`, `computeSubletPurgeDate`, `subletPurgeCutoffs`
- `apps/api/src/sublets/sublet.error.ts`: `SubletTextLocation`, `SubletError`
- `apps/api/src/sublets/sublet.service.ts`: `SubletApartmentView`, `SubletTribunalPermissionView`, `OwnSubletApplicationView`, `SubletApplicantView`, `QueuedSubletApplicationView`, `SubletIntakeView`, `SubletQueueView`, `ApplyForSubletInput`, `ReviseSubletInput`, `DecideSubletInput`, `TribunalPermissionInput`, `LettingEndInput`, `SubletService`
- `apps/api/src/sublets/sublets.controller.ts`: `SubletIntakeController`, `SubletQueueController`
- `apps/api/src/sublets/sublets.module.ts`: `SubletsModule`

## `apps/api/src/testing`

Exports by file:

- `apps/api/src/testing/advisory-locks.ts`: `advisoryLockCount`, `terminateAdvisoryLockHolder`, `terminateAdvisoryLockWaiters`, `cancelAdvisoryLockWaiters`, `holdLockCount`, `residencyApartmentLockCount`, `waitingLockCount`, `blockedBehindResidencyApartmentCount`, `waitFor`
- `apps/api/src/testing/application-on-own-database.ts`: `ApplicationOnOwnDatabase`, `applicationOnOwnDatabase`
- `apps/api/src/testing/domain-response.ts`: `domainResponse`
- `apps/api/src/testing/erasure-requests.ts`: `grantErasure`
- `apps/api/src/testing/erasure-source-facts.ts`: `API_SOURCE_DIRECTORY`, `Schedule`, `SourceFacts`, `erasureSourceFacts`
- `apps/api/src/testing/held-reports.ts`: `holdReports`
- `apps/api/src/testing/integration-database.ts`: `INTEGRATION_WORKER_COUNT`, `BASE_URL_VARIABLE`, `databaseName`, `withDatabase`, `maintenanceUrl`, `templateDatabaseName`, `workerDatabaseName`, `redirectToWorker`, `quoteIdentifier`, `redact`
- `apps/api/src/testing/integration-env.ts`: `loadEnvForIntegrationTests`, `restoreEnvironmentVariable`, `runSuffix`, `runPhone`, `runIdentityNumber`
- `apps/api/src/testing/integration-global-setup.ts`: `setup`
- `apps/api/src/testing/lock-waiters.ts`: `backendPid`, `waitersBehind`
- `apps/api/src/testing/mail-template-checks.ts`: `DeclaredMailTemplate`, `RegisteredMailTemplate`, `registryCoverageProblems`, `unexplainedNoProcessing`
- `apps/api/src/testing/person-columns.ts`: `ColumnsOf`, `SCHEMA_FILE`, `personColumns`
- `apps/api/src/testing/scratch-databases.ts`: `withClient`, `ScratchDatabases`, `scratchDatabases`
- `apps/api/src/testing/theme-fixtures.ts`: `FixtureCatalogEntry`, `FixtureCatalog`, `repositoryRoot`, `buildThemeFixtureCatalog`
- `apps/api/src/testing/xlsx-fixture.ts`: `WorkbookDate`, `WorkbookOverrides`, `buildWorkbook`

## `apps/api/src/text`

Exports by file:

- `apps/api/src/text/prefix.ts`: `prefix`

## `apps/api/src/themes`

`ThemesModule` in `apps/api/src/themes/themes.module.ts`. Themes.

- Imports: `PackagingModule`
- Controllers: `ActiveThemeController`, `ThemeListController`, `ThemeAdminController`
- Providers: `ThemeService`, `ThemeInstallService`, `ThemeStore`, `CatalogThemeSource`
- Exports: `ThemeService`

Exports by file:

- `apps/api/src/themes/theme-compose.ts`: `COMPOSED_AUDIT_SOURCE`, `ComposeThemeInput`, `ComposedTheme`, `ComposeResult`, `nextComposedVersion`, `composedSourceUrl`, `composedChecksum`, `composedManifest`
- `apps/api/src/themes/theme-install.service.ts`: `ThemeInstallError`, `CatalogThemeView`, `ThemeInstallResult`, `ThemeInstallService`
- `apps/api/src/themes/theme-lock.ts`: `lockThemes`, `underThemeLock`
- `apps/api/src/themes/theme-source.ts`: `FETCH_TIMEOUT_MS`, `ThemeSourceError`, `ThemeSource`, `CatalogThemeSource`
- `apps/api/src/themes/theme-store.ts`: `StagedTheme`, `DetachedTheme`, `ThemeStore`
- `apps/api/src/themes/theme.controller.ts`: `ActiveThemeController`, `ThemeListController`, `ThemeAdminController`
- `apps/api/src/themes/theme.service.ts`: `ThemeError`, `ThemeFontSummary`, `ThemeSummary`, `ThemeDeclaration`, `ThemeRendering`, `themeAssetUrl`, `asTokenRecord`, `resolvedViewVariants`, `ThemeService`
- `apps/api/src/themes/themes.module.ts`: `ThemesModule`
