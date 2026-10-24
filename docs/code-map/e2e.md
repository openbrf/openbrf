# Code map: the end-to-end suite

Generated from the source by `pnpm code-map`; `pnpm lint:guards` fails when it is stale. One section per directory of `e2e/src`, listing every name each file exports. Suites are left out. Change the source and regenerate rather than editing this file.

## `e2e/src`

- `e2e/src/agenda-proposal.ts`: `proposeAgenda`
- `e2e/src/apartment-binder.ts`: `BinderEntryFixture`, `binderEntry`, `StoredFile`, `fetchStored`, `BinderListing`, `readBinders`
- `e2e/src/apartments.ts`: `ClaimedApartment`, `claimApartment`
- `e2e/src/api.ts`: `jsonBodyOrNothing`, `SetupState`, `setupState`, `FirstAdministratorInput`, `createFirstAdministrator`, `attemptFirstAdministrator`, `signIn`, `saveHousingCooperative`, `AddressView`, `listAddresses`, `createAddress`, `ApartmentView`, `listApartments`, `addApartments`, `saveSmtp`, `saveBoardMailbox`, `BoardMailboxThreadRow`, `listBoardMailboxThreads`, `collectBoardMailbox`, `InstanceSettings`, `settings`, `setSelfSignup`, `installPlugin`, `PluginViewListing`, `pluginViews`, `setMotionDeadline`, `MeetingBylaws`, `STATUTORY_MEETING_BYLAWS`, `setMeetingBylaws`, `completeSetup`, `createPerson`, `sendInvitation`, `acceptInvitation`, `submitSignupRequest`, `PendingSignupRequest`, `listSignupRequests`, `setProtectedPersonalData`, `Viewer`, `viewer`, `TransferInput`, `TransferKind`, `MoveInResult`, `moveIn`, `MoveOutResult`, `moveOut`, `IssueTypeRow`, `listIssueTypes`, `createIssueType`, `setPublicIssueReporting`, `QueuedIssueRow`, `listIssueQueue`, `AddressBookRow`, `findPersonByName`, `findPeopleByName`, `findPersonIdByName`, `processingRestrictedAt`, `SitePageBlock`, `SitePageRow`, `createSitePage`, `publishSitePage`, `deleteSitePage`, `ContactSubmissionRow`, `listContactSubmissions`, `postContactForm`, `markContactSubmissionHandled`, `AssociationFactsInput`, `saveAssociationFacts`, `clearAssociationFacts`, `setPublicationConsent`, `BreachRow`, `recordPersonalDataBreach`, `ProcessorRow`, `listProcessors`, `setDataProtectionContacts`, `registerOAuthClient`, `protectedResource`
- `e2e/src/board.ts`: `BOARD_PAGE_NOT_OFFERED`, `grantBoardSeat`
- `e2e/src/bookings.ts`: `BookableResourceSummary`, `BookableResource`, `BookableResourceInput`, `BookableSlot`, `BookingApartment`, `OwnBooking`, `timeSlotResource`, `ensureResource`, `ownApartments`, `slotsOn`, `bookNthSlotOn`, `ownBookings`
- `e2e/src/database.ts`: `AuditEntry`, `auditEntriesFor`, `AuditActionEntry`, `registerRowCounts`, `auditEntriesByAction`, `MemberRegisterEntryRow`, `memberRegisterEntriesByRecordedName`
- `e2e/src/devices.ts`: `SeededDeviceToken`, `seedDeviceToken`, `deviceTokenRevoked`, `removeDeviceToken`
- `e2e/src/display-layout.ts`: `LAYOUT_NOW`, `LAYOUT_SECONDS`, `FULLEST_SLIDES`, `layoutDocument`, `SlideMeasure`, `measureSlide`
- `e2e/src/documents.ts`: `DocumentFixture`, `pdfBytes`, `documentFixture`, `ArchivedDocument`, `readArchive`, `documentNamed`, `fileDocument`, `removeDocument`
- `e2e/src/environment-reader.ts`: `ENVIRONMENT_READER_SOURCE`
- `e2e/src/events.ts`: `EventVisibility`, `EventRecurrence`, `EventOccurrence`, `EventSeries`, `EventSeriesInput`, `OwnSignup`, `AttendableOccurrence`, `signupSeries`, `eventSeriesTitled`, `ensureEventSeries`, `offeredOccurrence`, `signUpFor`
- `e2e/src/feed.ts`: `FeedPerson`, `signInThroughTheScreen`, `browseAs`, `ensureResident`, `ensureBoardMember`, `openFeed`, `audienceId`, `audienceButton`, `postCard`, `writePostThroughTheScreen`, `pngBytes`
- `e2e/src/fees.ts`: `recordFee`
- `e2e/src/fixtures.ts`: `clientAddressFor`, `test`, `stack`
- `e2e/src/global-setup.ts`: `globalSetup`
- `e2e/src/global-teardown.ts`: `globalTeardown`
- `e2e/src/identity.ts`: `uniqueEmail`, `uniqueSurname`, `uniquePersonalIdentityNumber`
- `e2e/src/image-pull.ts`: `isTransientPullFailure`, `PullRetryOptions`, `pullWithRetry`
- `e2e/src/issues.ts`: `grantPropertyManager`
- `e2e/src/mailpit.ts`: `Message`, `clearMailbox`, `listMessages`, `messageText`, `waitForMessage`, `expectNoMessage`, `deliverToMailbox`, `linkFrom`
- `e2e/src/navigation.ts`: `primaryNavigation`, `offeredDestinations`, `offeredDestinationsWithCounts`, `goToDestination`
- `e2e/src/news.ts`: `NewsChannelReport`, `NewsRow`, `PublishedNewsRow`, `newsBody`, `listNews`, `createNews`, `editNews`, `publishNews`, `setPreferredLocale`
- `e2e/src/pending-changes.ts`: `holdPendingChange`, `releasePendingChanges`
- `e2e/src/plugins.ts`: `waitForRestart`, `cli`
- `e2e/src/provision.ts`: `HOUSING_COOPERATIVE`, `ADMINISTRATOR`, `ADDRESSES`, `apartmentRows`, `signInAsAdministrator`, `ensureInstance`, `RegisterPerson`, `REGISTER_PEOPLE`, `ensureRegisterFixture`, `activationTokenFrom`, `ensureAccountFor`
- `e2e/src/shared-environment.ts`: `SharedEnvironmentStack`, `SharedEnvironmentOptions`, `sharedEnvironmentStack`
- `e2e/src/site.ts`: `SitePageFixture`, `SitePageStatus`, `createSitePage`, `frontPage`, `chooseFrontPage`, `setInMenu`, `isInMenu`, `deleteSitePage`, `pngPicture`, `uploadSitePicture`
- `e2e/src/stack.ts`: `repositoryRoot`, `e2eRoot`, `PROJECT_NAME`, `stack`, `managementTokenDigest`, `APP_BASE_PATH`, `appPath`, `startStack`, `builtImage`, `databaseImage`, `stopStack`, `runInAppContainer`, `runAsSuperuser`, `runSchemaOwner`, `runMigrate`, `runInNewAppContainer`, `appStartedAt`, `productionComposeConfig`, `serviceLogs`, `claimLinkFromLog`, `claimTokenOf`, `STACK_LOG_FILE`, `saveStackLogs`
- `e2e/src/totp.ts`: `TotpParameters`, `parseOtpauthUri`, `totpCode`, `secondsLeftInStep`
- `e2e/src/xlsx.ts`: `buildWorkbook`
