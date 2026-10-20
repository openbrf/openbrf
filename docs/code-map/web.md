# Code map: the web application

Generated from the source by `pnpm code-map`; `pnpm lint:guards` fails when it is stale. One section per directory of `apps/web/src`, listing every name each file exports. Suites are left out. Change the source and regenerate rather than editing this file.

## `apps/web/src/accounting`

- `apps/web/src/accounting/AccountingBasisPanel.tsx`: `AccountingBasisPanel`
- `apps/web/src/accounting/accounting-api.ts`: `AccountingBasisRowKind`, `AccountingBasisApartment`, `AccountingBasisRow`, `AccountingBasis`, `AccountingBasisExport`, `exportAccountingBasis`
- `apps/web/src/accounting/accounting-failures.ts`: `accountingFailureKey`

## `apps/web/src/activate`

- `apps/web/src/activate/ActivateScreen.tsx`: `ActivateScreenProps`, `ActivateScreen`
- `apps/web/src/activate/activate-api.ts`: `acceptInvitation`

## `apps/web/src/apartment-binder`

- `apps/web/src/apartment-binder/ApartmentBinderScreen.tsx`: `ApartmentBinderScreenProps`, `ApartmentBinderScreen`
- `apps/web/src/apartment-binder/BinderEntryRow.tsx`: `BinderEntryRowProps`, `BinderEntryRow`
- `apps/web/src/apartment-binder/BoardApartmentChooser.tsx`: `BoardApartmentChooserProps`, `BoardApartmentChooser`
- `apps/web/src/apartment-binder/FileEntryPanel.tsx`: `FileEntryPanelProps`, `FileEntryPanel`
- `apps/web/src/apartment-binder/apartment-binder-api.ts`: `BINDER_KINDS`, `BinderKind`, `BINDER_AUDIENCES`, `BinderAudience`, `BinderFiler`, `BinderFilerView`, `BinderEntry`, `BoardBinderEntry`, `Binder`, `BoardBinderSummary`, `BoardBinder`, `BinderEntryFields`, `fetchMyBinders`, `fileInMyBinder`, `takeOutOfMyBinder`, `fetchBinders`, `fetchBinder`, `fileAsBoard`, `takeOutAsBoard`
- `apps/web/src/apartment-binder/binder-failures.ts`: `binderFailureKey`, `PART_SENTENCE`, `scannedBinderParts`
- `apps/web/src/apartment-binder/binder-kinds.ts`: `KIND_LABEL`, `AUDIENCE_LABEL`, `AUDIENCE_HINT`, `FILED_AS_LABEL`, `isTheBoards`, `carriesItsDay`, `defaultAudienceFor`, `kindsFiledBy`, `BinderGroup`, `groupByKind`

## `apps/web/src/api`

- `apps/web/src/api/board-mailbox.ts`: `BoardMailboxThreadStatus`, `BOARD_MAILBOX_STATUSES`, `BoardMailboxMember`, `BoardMailboxCorrespondent`, `BoardMailboxCorrespondentDomain`, `BoardMailboxAttachment`, `BoardMailboxMessage`, `BoardMailboxThreadSummary`, `BoardMailboxThread`, `BoardMailboxThreadList`, `BoardMailboxStatus`, `BoardMailboxSetAside`, `BoardMailboxCollection`, `fetchBoardMailboxStatus`, `fetchBoardMailboxThreads`, `fetchBoardMailboxThread`, `takeBoardMailboxThread`, `releaseBoardMailboxThread`, `replyToBoardMailboxThread`, `setBoardMailboxThreadClosed`, `collectBoardMailbox`
- `apps/web/src/api/bookings.ts`: `BookingResourceMode`, `BOOKING_RESOURCE_MODES`, `BookingStatus`, `BookingSlotState`, `BookingApartment`, `BookableSlot`, `OwnBooking`, `BookingBooker`, `ManagedBooking`, `BookableResourceSummary`, `BookableResource`, `BookableResourceInput`, `BookInput`, `BookingWindow`, `fetchBookableResources`, `fetchBookingApartments`, `fetchBookableSlots`, `fetchOwnBookings`, `bookSlot`, `cancelOwnBooking`, `fetchBoardBookableResources`, `fetchManagedBookings`, `cancelBookingForBoard`, `fetchAllBookableResources`, `createBookableResource`, `updateBookableResource`, `deactivateBookableResource`
- `apps/web/src/api/client.ts`: `ApiFailure`, `ApiResult`, `apiRequest`, `apiUpload`
- `apps/web/src/api/contact.ts`: `ContactSubmission`, `ContactInboxPage`, `fetchContactSubmissions`, `deleteContactSubmission`, `deleteContactSubmissions`, `setContactSubmissionHandled`
- `apps/web/src/api/data-protection.ts`: `BreachRisk`, `BreachState`, `BreachSubject`, `BreachView`, `RecordBreachInput`, `DecideBreachInput`, `UpdateBreachInput`, `LegalBasis`, `ProcessingActivityView`, `ProcessingRecord`, `ProcessorClassification`, `ProcessorAgreementState`, `ProcessorKind`, `ProcessorView`, `ProcessorAgreementInput`, `PrivacyNoticeSection`, `PrivacyNoticeCoverage`, `DataProtectionOverview`, `fetchDataProtectionOverview`, `fetchBreaches`, `recordBreach`, `decideBreach`, `updateBreach`, `addBreachSubject`, `markBreachSubjectInformed`, `closeBreach`, `fetchProcessingRecord`, `updateProcessingActivity`, `fetchProcessors`, `recordProcessorAgreement`, `fetchPrivacyNoticeCoverage`, `appendPrivacyNoticeHeadings`, `DataSubjectRequestKind`, `ErasureGround`, `ErasureException`, `DataSubjectRequestView`, `fetchDataSubjectRequests`, `recordDataSubjectRequest`, `decideDataSubjectRequest`, `extendDataSubjectRequest`, `closeDataSubjectRequest`
- `apps/web/src/api/events.ts`: `EventRecurrenceFrequency`, `EVENT_RECURRENCE_FREQUENCIES`, `EventVisibility`, `EVENT_MAX_OCCURRENCES`, `EVENT_MAX_DURATION_MINUTES`, `EVENT_MAX_INTERVAL`, `EVENT_CALENDAR_WINDOW_DAYS`, `EventCalendarWindow`, `EventRecurrence`, `EventOccurrence`, `EventSeries`, `EventSeriesInput`, `PublishEventInput`, `OwnSignup`, `AttendableOccurrence`, `EventAttendee`, `RollCallEntry`, `RollCall`, `fetchUpcomingOccurrences`, `signUpForOccurrence`, `withdrawFromOccurrence`, `fetchEventSeries`, `createEventSeries`, `updateEventSeries`, `publishEventSeries`, `cancelEventOccurrence`, `reinstateEventOccurrence`, `removeEventSeries`, `fetchRollCall`, `withdrawSignupForBoard`
- `apps/web/src/api/feed.ts`: `FeedFilter`, `WHOLE_FEED`, `fetchAudiences`, `readFeed`, `postsSince`, `fetchPost`, `uploadPostImage`, `writePost`, `BoardPostDraft`, `writeBoardPost`, `pinPost`, `markPostRead`, `markAudienceRead`, `likePost`, `readComments`, `commentsSince`, `writeComment`, `likeComment`, `createGroup`, `fetchGroupMembers`, `fetchGroupCandidates`, `addGroupMember`, `leaveGroup`, `reportPost`, `fetchReports`, `strikeReport`, `dismissReport`
- `apps/web/src/api/instance.ts`: `SetupState`, `HousingCooperativeSettings`, `LogoView`, `LogoSlot`, `BrandingSettings`, `SmtpSettings`, `StoredSmtpSettings`, `EnvironmentMailSettings`, `BoardMailboxSettings`, `BoardMailboxInput`, `SmsSettings`, `InstanceSettings`, `Viewer`, `AddressView`, `ApartmentView`, `AddressInput`, `ApartmentRowInput`, `SmtpInput`, `SmsInput`, `ContrastFailure`, `fetchSetupState`, `createFirstAdministrator`, `completeSetup`, `fetchViewer`, `fetchSettings`, `saveHousingCooperative`, `saveBranding`, `uploadLogo`, `removeLogo`, `saveSmtp`, `sendSmtpTest`, `saveBoardMailbox`, `saveSms`, `sendSmsTest`, `FinanceSettings`, `saveFinances`, `saveRetention`, `saveSelfSignup`, `saveMeetingBylaws`, `saveOwnProfile`, `exportOwnData`, `DataProtectionContacts`, `saveDataProtectionContacts`, `fetchAddresses`, `createAddress`, `removeAddress`, `fetchApartments`, `addApartments`, `removeApartment`
- `apps/web/src/api/issues.ts`: `IssueAudience`, `IssueStatus`, `ISSUE_AUDIENCES`, `IssueTypeView`, `ReportableIssueType`, `IssueApartment`, `IssuePhoto`, `OwnIssue`, `IssueReporter`, `QueuedIssue`, `ReportIssueInput`, `IssueTypeInput`, `fetchReportableTypes`, `fetchOwnApartments`, `fetchOwnIssues`, `reportIssue`, `attachIssuePhoto`, `fetchIssueQueue`, `setIssueStatus`, `fetchIssueTypes`, `createIssueType`, `updateIssueType`, `removeIssueType`, `saveIssueReporting`
- `apps/web/src/api/key-orders.ts`: `KeyOrderKind`, `KeyOrderStatus`, `KeyOrderApartment`, `OwnKeyOrder`, `KeyOrderer`, `QueuedKeyOrder`, `KeyOrderIntake`, `KeyOrderQueue`, `fetchKeyOrderIntake`, `placeKeyOrder`, `reviseKeyOrder`, `withdrawKeyOrder`, `fetchKeyOrderQueue`, `answerKeyOrder`
- `apps/web/src/api/meetings.ts`: `MeetingKind`, `MEETING_KINDS`, `AttendanceCapacity`, `ATTENDANCE_CAPACITIES`, `AttendanceMode`, `ATTENDANCE_MODES`, `RepresentativeGround`, `REPRESENTATIVE_GROUNDS`, `MeetingDecisionOutcome`, `MEETING_DECISION_OUTCOMES`, `MEETING_AGENDA_MAX_ITEMS`, `MEETING_AGENDA_TITLE_MAX`, `MEETING_PLACE_MAX`, `MEETING_DIGITAL_PARTICIPATION_MAX`, `MEETING_VOTE_COUNT_MAX`, `MIN_MEMBERS_PER_PROXY_HOLDER`, `MAX_MEMBERS_PER_PROXY_HOLDER`, `MeetingDecision`, `AgendaItem`, `Attendance`, `ProxyAuthorisation`, `MeetingBylaws`, `VotingRegisterProxyHolder`, `VotingRegisterLine`, `VotingRegister`, `NoticeDeliveryReport`, `MeetingNotice`, `MeetingSummary`, `Meeting`, `ArrangeMeetingInput`, `SetAgendaInput`, `IssueNoticeInput`, `RecordAttendanceInput`, `RegisterProxyInput`, `RecordDecisionInput`, `fetchMeetings`, `fetchMeeting`, `arrangeMeeting`, `concludeMeeting`, `setMeetingAgenda`, `issueMeetingNotice`, `recordAttendance`, `withdrawAttendance`, `registerProxy`, `withdrawProxy`, `recordDecision`
- `apps/web/src/api/motions.ts`: `MotionStatus`, `MotionDeadline`, `MotionMeeting`, `OwnMotion`, `MotionSubmitter`, `QueuedMotion`, `MotionIntake`, `MotionQueue`, `fetchMotionIntake`, `submitMotion`, `withdrawMotion`, `fetchMotionQueue`, `acknowledgeMotion`, `setMotionMeeting`, `saveMotionDeadline`
- `apps/web/src/api/news-reader.ts`: `NewsArticleRun`, `NewsArticleBlock`, `NewsArticleContent`, `NewsArticle`, `NewsCommentAuthor`, `NewsComment`, `NewsCommentPage`, `fetchReadableNews`, `fetchNewsComments`, `writeNewsComment`, `hideNewsComment`
- `apps/web/src/api/signup.ts`: `SignupState`, `SignupSubmission`, `PendingSignupRequest`, `fetchSignupState`, `submitSignupRequest`, `fetchSignupRequests`, `approveSignupRequest`, `rejectSignupRequest`
- `apps/web/src/api/site.ts`: `PageStatus`, `PAGE_STATUSES`, `PageContent`, `AdminPage`, `NewPage`, `PageEdit`, `SiteImage`, `mediaPath`, `fetchPages`, `fetchPluginBlocks`, `createPage`, `savePage`, `setPageStatus`, `setFrontPage`, `reorderPages`, `deletePage`, `uploadSiteImage`
- `apps/web/src/api/sublets.ts`: `SubletApplicationStatus`, `SubletApartment`, `SubletTribunalPermission`, `OwnSubletApplication`, `SubletApplicant`, `QueuedSubletApplication`, `SubletIntake`, `SubletQueue`, `fetchSubletIntake`, `applyForSublet`, `reviseSubletApplication`, `withdrawSubletApplication`, `fetchSubletQueue`, `decideSubletApplication`, `recordSubletTribunalPermission`, `recordSubletLettingEnd`
- `apps/web/src/api/themes.ts`: `ThemeTokenValues`, `ThemeFontSummary`, `ThemeSummary`, `ThemeDeclaration`, `ComposeThemeInput`, `ThemeFontFace`, `ThemeRendering`, `CatalogTheme`, `ThemeLintFinding`, `ThemeInstallResult`, `fetchActiveTheme`, `fetchInstalledThemes`, `fetchThemeCatalog`, `installTheme`, `fetchThemePreview`, `composeTheme`, `fetchThemeSource`, `activateTheme`, `uninstallTheme`

## `apps/web/src/auth`

- `apps/web/src/auth/SignInScreen.tsx`: `SignInScreen`
- `apps/web/src/auth/auth-client.ts`: `authClient`, `signIn`, `signOut`, `useSession`
- `apps/web/src/auth/sign-in-methods.ts`: `SignInFailureCode`, `SignInOutcome`, `signInWithPassword`, `verifySecondFactor`, `signInWithPasskey`, `requestMagicLink`

## `apps/web/src/board-mailbox`

- `apps/web/src/board-mailbox/BoardMailboxScreen.tsx`: `BoardMailboxScreen`
- `apps/web/src/board-mailbox/BoardMailboxStatusChip.tsx`: `BoardMailboxStatusChip`
- `apps/web/src/board-mailbox/BoardMailboxThreadPanel.tsx`: `BoardMailboxThreadPanelProps`, `BoardMailboxThreadPanel`
- `apps/web/src/board-mailbox/board-mailbox-dates.ts`: `formatMailboxDay`, `formatMailboxMoment`

## `apps/web/src/bookings`

- `apps/web/src/bookings/BookSlotPanel.tsx`: `BookSlotPanelProps`, `BookSlotPanel`
- `apps/web/src/bookings/BookingBoardPanel.tsx`: `BookingBoardPanelProps`, `BookingBoardPanel`
- `apps/web/src/bookings/BookingPeriod.tsx`: `BookingPeriod`
- `apps/web/src/bookings/BookingStatusChip.tsx`: `BookingStatusChip`
- `apps/web/src/bookings/BookingsScreen.tsx`: `BookingsScreenProps`, `BookingsScreen`
- `apps/web/src/bookings/OwnBookingsPanel.tsx`: `OwnBookingsPanelProps`, `OwnBookingsPanel`
- `apps/web/src/bookings/booking-calendar.ts`: `ASSOCIATION_TIME_ZONE`, `windowDaysFor`, `localDayNow`, `localDayOfInstant`, `shiftLocalDay`, `compareLocalDays`, `formatTimeOfDay`, `formatDayWithWeekday`, `formatBookingDate`, `instantOfNoon`
- `apps/web/src/bookings/booking-failures.ts`: `ResourceWriteReason`, `bookingFailureKey`

## `apps/web/src/charges`

- `apps/web/src/charges/ChargesScreen.tsx`: `ChargesScreen`
- `apps/web/src/charges/RecordChargePanel.tsx`: `RecordChargePanel`
- `apps/web/src/charges/charge-failures.ts`: `chargeFailureKey`, `refusedIdentityNumbers`
- `apps/web/src/charges/charge-parties.ts`: `ChargeablePerson`, `ChargeableApartment`, `ChargeParties`, `loadChargeParties`, `markAmbiguous`
- `apps/web/src/charges/charges-api.ts`: `ChargeApartment`, `ChargedParty`, `VatTreatment`, `VAT_TREATMENTS`, `ChargeRow`, `DebitingList`, `DebitingListExport`, `ChargeInput`, `ChargeCorrection`, `fetchDebitingList`, `recordCharge`, `correctCharge`, `removeCharge`, `exportDebitingList`

## `apps/web/src/connected-apps`

- `apps/web/src/connected-apps/ConnectedAppsRoute.tsx`: `ConnectedAppsRoute`
- `apps/web/src/connected-apps/ConnectedAppsScreen.tsx`: `ConnectedAppsScreenProps`, `ConnectedAppsScreen`
- `apps/web/src/connected-apps/OAuthConsentScreen.tsx`: `OAuthConsentScreenProps`, `OAuthConsentScreen`
- `apps/web/src/connected-apps/RegisterClientPanel.tsx`: `RegisterClientPanel`
- `apps/web/src/connected-apps/connected-app-dates.ts`: `formatConnectedAppMoment`
- `apps/web/src/connected-apps/connected-app-failures.ts`: `disconnectFailureKey`, `registerClientFailureKey`, `revokeClientFailureKey`
- `apps/web/src/connected-apps/connections-api.ts`: `ConnectedApp`, `ConnectedAppGrant`, `RegisteredClient`, `ProtectedResourceDocument`, `fetchMyConnectedApps`, `disconnectMyConnectedApp`, `fetchConnectedApps`, `disconnectConnectedApp`, `registerOAuthClient`, `fetchProtectedResource`
- `apps/web/src/connected-apps/consent-api.ts`: `OAuthClientDetails`, `ActionCatalogue`, `ConsentGranted`, `fetchOAuthClient`, `fetchConnectedAppActions`, `grantConsent`

## `apps/web/src/data-protection`

- `apps/web/src/data-protection/BreachRegisterPanel.tsx`: `BreachRegisterPanelProps`, `BreachRegisterPanel`
- `apps/web/src/data-protection/DataProtectionScreen.tsx`: `DataProtectionScreenProps`, `DataProtectionScreen`
- `apps/web/src/data-protection/OverviewStrip.tsx`: `OverviewStripProps`, `OverviewStrip`
- `apps/web/src/data-protection/PrivacyNoticeCoveragePanel.tsx`: `PrivacyNoticeCoveragePanelProps`, `PrivacyNoticeCoveragePanel`
- `apps/web/src/data-protection/ProcessingActivitiesPanel.tsx`: `ProcessingActivitiesPanelProps`, `ProcessingActivitiesPanel`
- `apps/web/src/data-protection/ProcessorAgreementsPanel.tsx`: `ProcessorAgreementsPanelProps`, `ProcessorAgreementsPanel`

## `apps/web/src/documents`

- `apps/web/src/documents/AudienceField.tsx`: `AudienceSign`, `AudienceFieldProps`, `AudienceField`
- `apps/web/src/documents/DocumentRow.tsx`: `DocumentRowProps`, `DocumentRow`
- `apps/web/src/documents/DocumentsScreen.tsx`: `DocumentsScreenProps`, `DocumentsScreen`
- `apps/web/src/documents/FileDocumentPanel.tsx`: `FileDocumentPanelProps`, `FileDocumentPanel`
- `apps/web/src/documents/document-shelf.ts`: `DocumentShelf`, `shelvesOf`, `isMinutesBinder`, `audienceForBinder`, `FileSize`, `fileSizeOf`
- `apps/web/src/documents/documents-api.ts`: `DocumentAudience`, `DOCUMENT_AUDIENCES`, `ArchivedDocument`, `DocumentFields`, `fetchDocuments`, `fileDocument`, `editDocument`, `removeDocument`

## `apps/web/src/events`

- `apps/web/src/events/EventAdminPanel.tsx`: `EventAdminPanel`
- `apps/web/src/events/EventAttendPanel.tsx`: `EventAttendPanel`
- `apps/web/src/events/EventRollCall.tsx`: `EventRollCall`
- `apps/web/src/events/EventSeriesFields.tsx`: `EventSeriesFields`
- `apps/web/src/events/EventsScreen.tsx`: `EventsScreenProps`, `EventsScreen`
- `apps/web/src/events/event-calendar.ts`: `formatEventDay`, `minuteOfTimeValue`, `timeValueOfMinute`
- `apps/web/src/events/event-draft.ts`: `RecurrenceEnd`, `EventDraft`, `EMPTY_DRAFT`, `inputOf`, `draftOf`, `signatureOf`
- `apps/web/src/events/event-failures.ts`: `eventFailureKey`, `scannedFields`, `refusedDates`

## `apps/web/src/feed`

- `apps/web/src/feed/AudiencePanel.tsx`: `audienceName`, `AudiencePanelProps`, `AudiencePanel`
- `apps/web/src/feed/Author.tsx`: `writtenAt`, `authorLabel`, `Byline`, `Avatar`
- `apps/web/src/feed/FeedScreen.tsx`: `FeedScreenProps`, `FeedScreen`
- `apps/web/src/feed/FilterDialog.tsx`: `PostFilter`, `FilterDialog`
- `apps/web/src/feed/GroupPanel.tsx`: `GroupPanelProps`, `GroupPanel`
- `apps/web/src/feed/MoreMenu.tsx`: `MoreAction`, `MoreMenu`, `copyText`
- `apps/web/src/feed/PostCard.tsx`: `PostCardProps`, `PostCard`, `PostImages`
- `apps/web/src/feed/PostComposer.tsx`: `ComposerAudience`, `PostComposerProps`, `PostComposer`
- `apps/web/src/feed/PostScreen.tsx`: `PostScreenProps`, `PostScreen`
- `apps/web/src/feed/PostText.tsx`: `TextSegment`, `textSegments`, `PostText`
- `apps/web/src/feed/PostThread.tsx`: `PostThreadProps`, `PostThread`
- `apps/web/src/feed/ReportDialog.tsx`: `ReportDialog`
- `apps/web/src/feed/ReportQueue.tsx`: `ReportQueue`
- `apps/web/src/feed/ScheduledPosts.tsx`: `ScheduledPostsProps`, `ScheduledPosts`
- `apps/web/src/feed/feed-failures.ts`: `feedFailureKey`, `uploadFailureKey`, `groupNameFailureKey`, `feedReadFailureKey`
- `apps/web/src/feed/feed-fixtures.ts`: `ASTRID`, `BO`, `viewer`, `ALL`, `BOARD`, `STAIRWELL`, `GARDEN`, `post`, `comment`, `ok`, `refused`, `installIntersectionObserver`
- `apps/web/src/feed/feed-limits.ts`: `POST_MAX_LENGTH`, `BOARD_POST_TITLE_MAX_LENGTH`, `COMMENT_MAX_LENGTH`, `GROUP_NAME_MAX_LENGTH`, `SEARCH_MAX_LENGTH`, `MAX_IMAGES_PER_POST`, `POLL_INTERVAL_MS`, `SEARCH_DELAY_MS`
- `apps/web/src/feed/use-audiences.ts`: `AudienceListFailure`, `Audiences`, `useAudiences`
- `apps/web/src/feed/use-feed.ts`: `HeldFeed`, `Feed`, `filterKey`, `useFeed`
- `apps/web/src/feed/use-seen.ts`: `useSeen`

## `apps/web/src/fees`

- `apps/web/src/fees/FeeNoticeDocument.tsx`: `FeeNoticeDocument`
- `apps/web/src/fees/FeeNotificationsPanel.tsx`: `FeeNotificationsPanel`
- `apps/web/src/fees/FeesScreen.tsx`: `FeesScreen`
- `apps/web/src/fees/fee-failures.ts`: `feeFailureKey`
- `apps/web/src/fees/fees-api.ts`: `FeeKind`, `FeeVatTreatment`, `FeeRow`, `FeeRegisterApartment`, `FeeRegister`, `FeeInput`, `FeeNotificationSummary`, `FeeNoticeHolders`, `FeeNoticeRow`, `FeeNoticeDocument`, `FeeNoticeExport`, `fetchFeeRegister`, `recordFee`, `removeFee`, `fetchFeeNotifications`, `issueFeeNotification`, `produceFeeNotices`
- `apps/web/src/fees/participation-share.ts`: `ShareSuggestion`, `ShareSuggestions`, `suggestMonthlyAmounts`

## `apps/web/src/i18n`

- `apps/web/src/i18n/catalog-text.ts`: `catalogText`
- `apps/web/src/i18n/index.ts`: `default`
- `apps/web/src/i18n/translation-key.ts`: `TranslationKey`

## `apps/web/src/import`

- `apps/web/src/import/ImportScreen.tsx`: `ImportScreen`
- `apps/web/src/import/import-api.ts`: `IMPORT_FIELDS`, `ImportField`, `ImportOutcome`, `ImportMatchKey`, `ImportMismatch`, `ImportSessionView`, `ImportPreviewRow`, `ImportPreview`, `ImportPreviewStatus`, `ImportPreviewRun`, `ImportApplyResult`, `ImportRunStatus`, `ImportRunView`, `StartedImportRun`, `isImportRunning`, `ImportDecision`, `ImportMappingInput`, `IMPORT_TEMPLATE_URL`, `uploadImport`, `previewImport`, `fetchImportPreview`, `cancelImportPreview`, `applyImport`, `abandonImport`, `fetchImportRun`, `ACTIVE_IMPORT_TIMEOUT_MS`, `fetchActiveImport`, `readFileAsBase64`
- `apps/web/src/import/import-messages.ts`: `failureMessage`, `FAILURE_VALUES`, `mappingProblemMessages`, `problemMessage`, `FIELD_LABEL`, `RUN_STATUS_LABEL`, `RUN_TITLE`, `OUTCOME_LABEL`, `OUTCOME_TONE`

## `apps/web/src/issues`

- `apps/web/src/issues/IssueQueuePanel.tsx`: `IssueQueuePanelProps`, `IssueQueuePanel`
- `apps/web/src/issues/IssueStatusChip.tsx`: `IssueStatusChip`
- `apps/web/src/issues/IssuesScreen.tsx`: `IssuesScreenProps`, `IssuesScreen`
- `apps/web/src/issues/OwnIssuesPanel.tsx`: `OwnIssuesPanelProps`, `OwnIssuesPanel`
- `apps/web/src/issues/ReportIssuePanel.tsx`: `ReportIssuePanelProps`, `ReportIssuePanel`

## `apps/web/src/key-orders`

- `apps/web/src/key-orders/KeyOrderQueuePanel.tsx`: `KeyOrderQueuePanelProps`, `KeyOrderQueuePanel`
- `apps/web/src/key-orders/KeyOrderStatusChip.tsx`: `KeyOrderStatusChip`
- `apps/web/src/key-orders/KeyOrdersScreen.tsx`: `KeyOrdersScreenProps`, `KeyOrdersScreen`
- `apps/web/src/key-orders/OwnKeyOrdersPanel.tsx`: `OwnKeyOrdersPanelProps`, `OwnKeyOrdersPanel`
- `apps/web/src/key-orders/PlaceKeyOrderPanel.tsx`: `PlaceKeyOrderPanelProps`, `PlaceKeyOrderPanel`
- `apps/web/src/key-orders/key-order-failures.ts`: `keyOrderFailureKey`, `scannedKeyOrderParts`

## `apps/web/src/media`

- `apps/web/src/media/LogoField.tsx`: `LogoFieldProps`, `LogoField`

## `apps/web/src/meetings`

- `apps/web/src/meetings/MeetingAgendaPanel.tsx`: `MeetingAgendaPanelProps`, `MeetingAgendaPanel`
- `apps/web/src/meetings/MeetingCheckInPanel.tsx`: `MeetingCheckInPanelProps`, `MeetingCheckInPanel`
- `apps/web/src/meetings/MeetingDecisionsPanel.tsx`: `MeetingDecisionsPanelProps`, `MeetingDecisionsPanel`
- `apps/web/src/meetings/MeetingListPanel.tsx`: `MeetingListPanelProps`, `MeetingListPanel`
- `apps/web/src/meetings/MeetingNoticePanel.tsx`: `MeetingNoticePanelProps`, `MeetingNoticePanel`
- `apps/web/src/meetings/MeetingPersonName.tsx`: `MeetingPersonName`
- `apps/web/src/meetings/MeetingProxyPanel.tsx`: `MeetingProxyPanelProps`, `MeetingProxyPanel`
- `apps/web/src/meetings/MeetingsScreen.tsx`: `MeetingsScreenProps`, `MeetingsScreen`
- `apps/web/src/meetings/PersonSelect.tsx`: `PersonSelectProps`, `PersonSelect`
- `apps/web/src/meetings/VotingRegisterPanel.tsx`: `VotingRegisterPanelProps`, `VotingRegisterPanel`
- `apps/web/src/meetings/meeting-failures.ts`: `meetingFailureKey`
- `apps/web/src/meetings/use-meeting-people.ts`: `MeetingPerson`, `MeetingPeople`, `useMeetingPeople`

## `apps/web/src/motions`

- `apps/web/src/motions/MotionQueuePanel.tsx`: `MotionQueuePanelProps`, `MotionQueuePanel`
- `apps/web/src/motions/MotionStatusChip.tsx`: `MotionStatusChip`
- `apps/web/src/motions/MotionsScreen.tsx`: `MotionsScreenProps`, `MotionsScreen`
- `apps/web/src/motions/OwnMotionsPanel.tsx`: `OwnMotionsPanelProps`, `OwnMotionsPanel`
- `apps/web/src/motions/SubmitMotionPanel.tsx`: `SubmitMotionPanelProps`, `SubmitMotionPanel`
- `apps/web/src/motions/motion-failures.ts`: `motionFailureKey`, `scannedParts`

## `apps/web/src/moves`

- `apps/web/src/moves/MoveInPanel.tsx`: `MoveInPanel`
- `apps/web/src/moves/MoveOutPanel.tsx`: `MoveOutTarget`, `MoveOutPanel`
- `apps/web/src/moves/PersonSearch.tsx`: `PersonOption`, `PersonSearch`
- `apps/web/src/moves/move-errors.ts`: `failureMessage`
- `apps/web/src/moves/moves-api.ts`: `MoveRole`, `TransferKind`, `TransferInput`, `MoveInInput`, `MoveInResult`, `MoveOutInput`, `MoveOutResult`, `moveIn`, `moveOut`

## `apps/web/src/news`

- `apps/web/src/news/NewsBody.tsx`: `NewsBody`
- `apps/web/src/news/NewsScreen.tsx`: `NewsScreenProps`, `NewsScreen`
- `apps/web/src/news/NewsThread.tsx`: `NewsThreadProps`, `NewsThread`
- `apps/web/src/news/news-comment-failures.ts`: `newsCommentFailureKey`

## `apps/web/src/overview`

- `apps/web/src/overview/OverviewScreen.tsx`: `OverviewScreen`
- `apps/web/src/overview/ReadPanel.tsx`: `ITEM_ROW`, `ITEM_LINK`, `ReadPanel`
- `apps/web/src/overview/ResidentPanels.tsx`: `BookingsPanel`, `EventsPanel`, `NewsPanel`
- `apps/web/src/overview/ToHandlePanel.tsx`: `ToHandlePanel`
- `apps/web/src/overview/WaitingPanel.tsx`: `WaitingPanel`
- `apps/web/src/overview/overview-panels.ts`: `QueueId`, `QUEUES`, `WaitingSources`, `OverviewPanels`, `overviewPanelsFor`, `offersAnything`, `WaitingItem`, `waitingItems`, `BOOKINGS_SHOWN`, `upcomingBookings`, `EVENTS_SHOWN`, `nextEvents`, `NEWS_SHOWN`, `latestNews`
- `apps/web/src/overview/queue-counts.ts`: `QueueCount`, `CHAT_REPORTS_PER_PAGE`, `QUEUE_COUNTS`
- `apps/web/src/overview/use-read.ts`: `ReadState`, `useRead`

## `apps/web/src/plugins`

- `apps/web/src/plugins/CatalogPanel.tsx`: `CatalogPanelProps`, `CatalogPanel`
- `apps/web/src/plugins/ConsentPanel.tsx`: `ConsentPanelProps`, `ConsentPanel`
- `apps/web/src/plugins/FindingsPanel.tsx`: `FindingsPanelProps`, `FindingsPanel`
- `apps/web/src/plugins/InstalledPluginsPanel.tsx`: `InstalledPluginsPanelProps`, `InstalledPluginsPanel`
- `apps/web/src/plugins/PluginSettingsForm.tsx`: `PluginSettingsFormProps`, `PluginSettingsForm`, `SettingsFieldProps`, `SettingsField`
- `apps/web/src/plugins/PluginView.tsx`: `PluginViewProps`, `PluginView`
- `apps/web/src/plugins/PluginsScreen.tsx`: `PluginsScreenProps`, `PluginsScreen`
- `apps/web/src/plugins/RecipientQuestion.tsx`: `RecipientDraft`, `UNANSWERED`, `recipientAnswer`, `RecipientQuestionProps`, `RecipientQuestion`, `RecipientRecorded`
- `apps/web/src/plugins/plugin-api.ts`: `PluginSummary`, `PluginFinding`, `PluginsOverview`, `CatalogPlugin`, `CatalogListing`, `PluginSettingsResponse`, `PluginViewDescriptor`, `ProcessorAgreementAnswer`, `fetchPlugins`, `fetchCatalog`, `fetchPluginViews`, `installPlugin`, `uninstallPlugin`, `setPluginEnabled`, `setPluginActionArmed`, `fetchPluginSettings`, `savePluginSettings`
- `apps/web/src/plugins/plugin-i18n.ts`: `pluginNamespace`, `loadPluginTranslations`
- `apps/web/src/plugins/plugin-labels.ts`: `PERMISSION_LABELS`, `PERSONAL_DATA_LABELS`, `permissionLabel`, `personalDataLabel`, `ACTION_EFFECT_LABELS`, `actionEffectLabel`, `FINDING_LABELS`, `findingLabel`, `INSTALL_FAILURE_LABELS`, `installFailureLabel`, `ACTION_PERSONAL_DATA_LABELS`, `ACTION_SURFACE_LABELS`, `actionPersonalDataLabel`, `actionSurfaceLabel`
- `apps/web/src/plugins/plugin-remotes.ts`: `registerPluginRemote`, `loadPluginView`
- `apps/web/src/plugins/use-plugin-nav-items.ts`: `usePluginNavItems`
- `apps/web/src/plugins/use-plugin-translation.ts`: `PluginTranslator`, `usePluginTranslation`, `PluginsTranslator`, `usePluginsTranslation`

## `apps/web/src/register`

- `apps/web/src/register/AddPersonPanel.tsx`: `AddPersonPanel`
- `apps/web/src/register/ApartmentPanel.tsx`: `ApartmentPanel`
- `apps/web/src/register/Board.tsx`: `BoardProps`, `Board`
- `apps/web/src/register/DataSubjectReport.tsx`: `SECTION_TITLE`, `DataSubjectReportProps`, `DataSubjectReport`
- `apps/web/src/register/DataSubjectRequestsSection.tsx`: `DataSubjectRequestsSectionProps`, `DataSubjectRequestsSection`
- `apps/web/src/register/DatePair.tsx`: `DatePair`
- `apps/web/src/register/ExtensionNote.tsx`: `ExtensionNote`
- `apps/web/src/register/PersonPanel.tsx`: `PersonPanelProps`, `PersonPanel`
- `apps/web/src/register/SignChip.tsx`: `SignChip`, `SignRow`
- `apps/web/src/register/floor-groups.ts`: `UNKNOWN_FLOOR`, `FloorGroup`, `groupByFloor`
- `apps/web/src/register/register-api.ts`: `RegisterSign`, `SystemRole`, `BoardPositionType`, `BOARD_POSITION_TYPES`, `PersonBoardPosition`, `BoardPositionView`, `SystemRoleGrants`, `RegisterFilter`, `REGISTER_FILTERS`, `RESIDENT_FILTERS`, `RegisterApartment`, `RegisterContact`, `DirectoryRow`, `BoardRow`, `RegisterAddress`, `RegisterPage`, `MaskableField`, `MaskedPostalAddress`, `PersonResidency`, `ConsentScope`, `CONSENT_SCOPES`, `PublicationConsent`, `LegalHold`, `ReportPostalAddress`, `TerminationKind`, `ConnectedAppScope`, `NewsDeliveryFailure`, `MeetingNoticeDeliveryFailure`, `RegisterReportKind`, `TransferReportBasis`, `TransferReversalKind`, `ReportAuditAction`, `DataSubjectReport`, `PersonDetail`, `ErasureDomain`, `ErasureRefusal`, `ErasureWaitingOn`, `RevealedFields`, `ApartmentResidency`, `ApartmentDetail`, `CreatePersonInput`, `RegisterRequestError`, `REGISTER_MAX_PAGE_SIZE`, `RegisterQuery`, `fetchBoardRegister`, `fetchResidentDirectory`, `fetchPerson`, `fetchApartment`, `revealFields`, `createPerson`, `sendInvitation`, `setPublicationConsent`, `electToBoardPosition`, `fetchBoardRecoveryState`, `RecoveredSeat`, `recoverBoard`, `endBoardTerm`, `setSystemRole`, `setProtectedPersonalData`, `placeLegalHold`, `releaseLegalHold`, `fetchDataSubjectReport`
- `apps/web/src/register/report-document.ts`: `DOCUMENT_ATTRIBUTE`, `DOCUMENT`, `SECTION`, `SECTION_HEADING`, `FIELD_GRID`, `FIELD_LABEL`, `FIELD_VALUE`, `FIELD_TEXT`, `CELL`, `HEAD_CELL`, `DATA_CELL`, `TEXT_CELL`, `ROW`, `TABLE_SCROLL`, `TABLE`, `STAMP`
- `apps/web/src/register/use-address-book.ts`: `AddressBookView`, `AddressBookState`, `useAddressBook`, `useDebouncedValue`
- `apps/web/src/register/use-panel-heading-focus.ts`: `usePanelHeadingFocus`

## `apps/web/src/registers`

- `apps/web/src/registers/ApartmentParticularsPanel.tsx`: `ApartmentParticularsPanelProps`, `ApartmentParticularsPanel`
- `apps/web/src/registers/ApartmentRegisterScreen.tsx`: `ApartmentRegisterScreen`
- `apps/web/src/registers/ApartmentSharesPanel.tsx`: `ApartmentSharesPanelProps`, `ApartmentSharesPanel`
- `apps/web/src/registers/InitialSupplyScreen.tsx`: `InitialSupplyScreen`
- `apps/web/src/registers/MemberRegisterScreen.tsx`: `MemberRegisterScreen`
- `apps/web/src/registers/RegisterReportQueueScreen.tsx`: `RegisterReportQueueScreen`
- `apps/web/src/registers/document.ts`: `DOCUMENT_ATTRIBUTE`, `DOCUMENT`, `CELL`, `HEAD_CELL`, `DATA_CELL`, `ROW`, `TABLE_SCROLL`, `TABLE`, `STAMP`
- `apps/web/src/registers/registers-api.ts`: `RegisterHousingCooperative`, `MemberRegisterScope`, `RegisterPostalAddress`, `MemberRegisterApartment`, `MemberRegisterRow`, `MemberRegisterExtract`, `fetchMemberRegister`, `RegisterIdentityNumber`, `ApartmentRegisterHolder`, `ApartmentRegisterLien`, `ApartmentRegisterTransfer`, `TransferReportBasis`, `TransferReversalKind`, `ApartmentRegisterTransferReversal`, `TerminationKind`, `ApartmentRegisterTermination`, `ApartmentRegisterRow`, `LandTenure`, `ApartmentRegisterHousingCooperative`, `ApartmentRegisterExtract`, `fetchApartmentRegister`, `revealApartmentRegister`, `fetchOwnApartmentRegister`, `revealOwnApartmentRegister`, `noteLien`, `releaseLien`, `recordTermination`, `recordReportBasis`, `recordTransferReversal`, `recordApartmentShares`, `recordApartmentParticulars`, `recordPropertyDesignation`, `recordLandTenure`, `RegisterReportKind`, `RegisterReportState`, `RegisterReportDuty`, `RegisterReportElsewhere`, `RegisterReportQueue`, `fetchRegisterReportQueue`, `recordRegisterReportMade`, `SupplyRecordType`, `SupplyRow`, `InitialSupply`, `produceInitialSupply`

## `apps/web/src/routes`

- `apps/web/src/routes/ActivateRoute.tsx`: `ActivateRoute`
- `apps/web/src/routes/AddressBookRoute.tsx`: `AddressBookRoute`
- `apps/web/src/routes/ApartmentBinderRoute.tsx`: `ApartmentBinderRoute`
- `apps/web/src/routes/ApartmentRegisterRoute.tsx`: `ApartmentRegisterRoute`
- `apps/web/src/routes/BoardMailboxRoute.tsx`: `BoardMailboxRoute`
- `apps/web/src/routes/BookingsRoute.tsx`: `BookingsRoute`
- `apps/web/src/routes/ChargesRoute.tsx`: `ChargesRoute`
- `apps/web/src/routes/DataProtectionRoute.tsx`: `DataProtectionRoute`
- `apps/web/src/routes/DocumentsRoute.tsx`: `DocumentsRoute`
- `apps/web/src/routes/EventsRoute.tsx`: `EventsRoute`
- `apps/web/src/routes/FeedRoute.tsx`: `FeedRoute`, `PostRoute`
- `apps/web/src/routes/FeesRoute.tsx`: `FeesRoute`
- `apps/web/src/routes/ImportRoute.tsx`: `ImportRoute`
- `apps/web/src/routes/InitialSupplyRoute.tsx`: `InitialSupplyRoute`
- `apps/web/src/routes/IssuesRoute.tsx`: `IssuesRoute`
- `apps/web/src/routes/KeyOrdersRoute.tsx`: `KeyOrdersRoute`
- `apps/web/src/routes/MeetingsRoute.tsx`: `MeetingsRoute`
- `apps/web/src/routes/MemberRegisterRoute.tsx`: `MemberRegisterRoute`
- `apps/web/src/routes/MotionsRoute.tsx`: `MotionsRoute`
- `apps/web/src/routes/NewsReaderRoute.tsx`: `NewsReaderRoute`
- `apps/web/src/routes/NewsRoute.tsx`: `NewsRoute`
- `apps/web/src/routes/OAuthConsentRoute.tsx`: `OAuthConsentRoute`
- `apps/web/src/routes/OverviewRoute.tsx`: `OverviewRoute`
- `apps/web/src/routes/PluginViewRoute.tsx`: `PluginViewRoute`
- `apps/web/src/routes/PluginsRoute.tsx`: `PluginsRoute`
- `apps/web/src/routes/RegisterReportQueueRoute.tsx`: `RegisterReportQueueRoute`
- `apps/web/src/routes/RequestAccountRoute.tsx`: `RequestAccountRoute`
- `apps/web/src/routes/SettingsRoute.tsx`: `SettingsRoute`
- `apps/web/src/routes/SetupRoute.tsx`: `SetupRoute`
- `apps/web/src/routes/SignInRoute.tsx`: `SignInRoute`
- `apps/web/src/routes/SignedInFrame.tsx`: `SignedInFrame`
- `apps/web/src/routes/SiteAdminRoute.tsx`: `SiteAdminRoute`, `SitePageRoute`
- `apps/web/src/routes/SiteMenuRoute.tsx`: `SiteMenuRoute`
- `apps/web/src/routes/SubletsRoute.tsx`: `SubletsRoute`
- `apps/web/src/routes/ThemeComposerRoute.tsx`: `ThemeComposerRoute`
- `apps/web/src/routes/ThemesRoute.tsx`: `ThemesRoute`
- `apps/web/src/routes/authorization-request.ts`: `stringifyKeeping`, `stringifySearch`, `APP_BASE_PATH`, `CONSENT_PATH`, `SIGN_IN_PATH`, `AuthorizationSearch`, `validateAuthorizationSearch`, `authorizationRequestIn`, `consentHref`, `signInHref`
- `apps/web/src/routes/return-to.ts`: `safeReturnTo`
- `apps/web/src/routes/router.tsx`: `router`

## `apps/web/src/settings`

- `apps/web/src/settings/AddressesPanel.tsx`: `AddressesPanelProps`, `AddressesPanel`
- `apps/web/src/settings/ApartmentsPanel.tsx`: `ApartmentsPanelProps`, `ApartmentsPanel`
- `apps/web/src/settings/BoardMailboxPanel.tsx`: `BoardMailboxPanelProps`, `BoardMailboxPanel`
- `apps/web/src/settings/BookableResourcesPanel.tsx`: `BookableResourcesPanel`
- `apps/web/src/settings/BrandingPanel.tsx`: `BrandingPanelProps`, `BrandingPanel`
- `apps/web/src/settings/ContactInboxPanel.tsx`: `ContactInboxPanel`
- `apps/web/src/settings/DataProtectionContactsPanel.tsx`: `DataProtectionContactsPanelProps`, `DataProtectionContactsPanel`
- `apps/web/src/settings/FinancesPanel.tsx`: `FinancesPanelProps`, `FinancesPanel`
- `apps/web/src/settings/HousingCooperativePanel.tsx`: `HousingCooperativePanelProps`, `HousingCooperativePanel`
- `apps/web/src/settings/IssueReportingPanel.tsx`: `IssueReportingPanelProps`, `IssueReportingPanel`
- `apps/web/src/settings/IssueTypesPanel.tsx`: `IssueTypesPanel`
- `apps/web/src/settings/MeetingBylawsPanel.tsx`: `MeetingBylawsPanelProps`, `MeetingBylawsPanel`
- `apps/web/src/settings/MotionDeadlinePanel.tsx`: `MotionDeadlinePanelProps`, `MotionDeadlinePanel`
- `apps/web/src/settings/ProfilePanel.tsx`: `ProfilePanelProps`, `ProfilePanel`
- `apps/web/src/settings/RetentionPanel.tsx`: `RetentionPanelProps`, `RetentionPanel`
- `apps/web/src/settings/SecurityPanel.tsx`: `SecurityPanel`
- `apps/web/src/settings/SelfSignupPanel.tsx`: `SelfSignupPanelProps`, `SelfSignupPanel`
- `apps/web/src/settings/SettingsNav.tsx`: `SettingsNavProps`, `SettingsNav`
- `apps/web/src/settings/SettingsScreen.tsx`: `SettingsScreenProps`, `SettingsScreen`
- `apps/web/src/settings/SignupRequestQueuePanel.tsx`: `SignupRequestQueuePanelProps`, `SignupRequestQueuePanel`
- `apps/web/src/settings/SmsPanel.tsx`: `SmsPanelProps`, `SmsPanel`
- `apps/web/src/settings/SmtpPanel.tsx`: `SmtpPanelProps`, `SmtpPanel`
- `apps/web/src/settings/drop-focus.ts`: `dropFocus`
- `apps/web/src/settings/settings-sections.ts`: `SettingsSectionGroup`, `SETTINGS_SECTIONS`, `SettingsSectionId`, `SettingsAccess`, `settingsAccessOf`, `SettingsPanelId`, `SettingsPanelInput`, `SETTINGS_PANELS`, `panelsIn`, `sectionsFor`
- `apps/web/src/settings/use-focus-across-reload.ts`: `useFocusAcrossReload`

## `apps/web/src/setup`

- `apps/web/src/setup/AdministratorStep.tsx`: `AdministratorStep`
- `apps/web/src/setup/SetupWizard.tsx`: `SetupWizardProps`, `SetupWizard`
- `apps/web/src/setup/setup-claim.ts`: `SETUP_CLAIM_STORAGE_KEY`, `SetupClaimStorage`, `browserClaimStorage`, `claimInFragment`, `takeClaimFromAddress`, `readHeldClaim`, `holdClaim`, `forgetClaim`

## `apps/web/src/shell`

- `apps/web/src/shell/AppShell.tsx`: `AppShellProps`, `AppShell`
- `apps/web/src/shell/NavSheet.tsx`: `NavSheet`
- `apps/web/src/shell/SectionSign.tsx`: `NavCount`, `countOf`, `RowClasses`, `DestinationRow`, `SectionSign`
- `apps/web/src/shell/nav-items.ts`: `NAV_SECTIONS`, `NavSectionId`, `NavItem`, `OfferedSection`, `NAV_ITEMS`, `navItemsFor`, `OfferedPluginView`, `pluginNavItems`, `sectionsOf`, `currentDestination`
- `apps/web/src/shell/use-disclosure.ts`: `Disclosure`, `useDisclosure`
- `apps/web/src/shell/use-housing-cooperative-logo.ts`: `BandLogoUrls`, `useHousingCooperativeLogo`
- `apps/web/src/shell/use-nav-label.ts`: `useNavLabel`
- `apps/web/src/shell/use-viewer-capabilities.ts`: `useViewerCapabilities`

## `apps/web/src/signup`

- `apps/web/src/signup/RequestAccountScreen.tsx`: `RequestAccountScreen`

## `apps/web/src/site-admin`

- `apps/web/src/site-admin/AssociationFactsPanel.tsx`: `AssociationFactsPanel`
- `apps/web/src/site-admin/BlockInserter.tsx`: `InserterChoice`, `BlockInserterProps`, `BlockInserter`
- `apps/web/src/site-admin/BlockSettings.tsx`: `BlockSettingsProps`, `BlockSettings`
- `apps/web/src/site-admin/CanvasBlock.tsx`: `CanvasBlock`, `UNREGISTERED_HINT`, `PlainText`
- `apps/web/src/site-admin/EditorCanvas.tsx`: `EditorCanvasProps`, `EditorCanvas`
- `apps/web/src/site-admin/EditorIcon.tsx`: `EditorAction`, `EditorIcon`
- `apps/web/src/site-admin/LayoutBlockFields.tsx`: `LinkablePage`, `BlockFieldsContext`, `ButtonSettings`, `PictureFields`, `HeadingSettings`, `BannerSettings`, `ImageTextSettings`, `ColumnsSettings`
- `apps/web/src/site-admin/MenuEntryForm.tsx`: `generatedLabelKey`, `MenuEntryFormProps`, `MenuEntryForm`
- `apps/web/src/site-admin/MenuScreen.tsx`: `MenuScreen`
- `apps/web/src/site-admin/NewsItemPanel.tsx`: `NewsItemPanelProps`, `NewsItemPanel`
- `apps/web/src/site-admin/NewsScreen.tsx`: `NewsScreenProps`, `NewsScreen`
- `apps/web/src/site-admin/PageEditor.tsx`: `PageEditorProps`, `PageEditor`
- `apps/web/src/site-admin/PageEditorScreen.tsx`: `PageEditorScreenProps`, `PageEditorScreen`
- `apps/web/src/site-admin/PageSettings.tsx`: `PAGE_STATUS_LABELS`, `PageSettingsProps`, `PageSettings`
- `apps/web/src/site-admin/PlaceOnPage.tsx`: `PlaceOnPageProps`, `PlaceOnPage`
- `apps/web/src/site-admin/PluginBlockFields.tsx`: `PluginBlockFieldsProps`, `PluginBlockFields`
- `apps/web/src/site-admin/RichText.tsx`: `Caret`, `RichTextProps`, `RichText`
- `apps/web/src/site-admin/SiteAdminScreen.tsx`: `SiteAdminScreenProps`, `SiteAdminScreen`
- `apps/web/src/site-admin/block-tree.ts`: `BlockPlace`, `isNestable`, `samePlace`, `placeOf`, `entryOf`, `updateBlock`, `takeOut`, `mayStandAt`, `putIn`, `moveTo`, `placesFor`, `duplicate`, `ArrangementUndo`, `undoArrangement`, `DropTarget`, `resolveDrop`
- `apps/web/src/site-admin/canvas-context.ts`: `CanvasState`, `CanvasActions`, `CanvasStore`, `createCanvasStore`, `CanvasActionsContext`, `CanvasStoreContext`, `useCanvasActions`, `useCanvasState`
- `apps/web/src/site-admin/canvas-stylesheet.ts`: `CANVAS_CLASS`, `canvasStylesheet`
- `apps/web/src/site-admin/menu-api.ts`: `MenuItemKind`, `MENU_ITEM_KINDS`, `MenuGeneratedKey`, `MENU_GENERATED_KEYS`, `PageStatus`, `MENU_LABEL_LIMIT`, `MenuItem`, `MenuPage`, `MenuItemFields`, `fetchMenu`, `fetchMenuPages`, `addMenuItem`, `saveMenuItem`, `removeMenuItem`, `orderMenu`
- `apps/web/src/site-admin/news-api.ts`: `NewsVisibility`, `NewsRun`, `NewsBlock`, `NewsContent`, `NewsDeliveryReport`, `NewsMailingReport`, `NewsItem`, `PublishedNewsItem`, `NewsFields`, `NewsEdit`, `PublishFields`, `NewsRecipients`, `fetchNews`, `fetchRecipientCount`, `createNews`, `editNews`, `publishNews`, `dismissNewsMailingRequest`, `removeNews`
- `apps/web/src/site-admin/news-body.ts`: `contentFromText`, `isPlainText`, `textFromContent`
- `apps/web/src/site-admin/page-blocks.ts`: `INSERTABLE`, `InsertableBlock`, `blockLabel`, `EditorRegistry`, `editorRegistry`, `pluginBlockOf`, `newPluginBlock`, `pluginSettingsOf`, `withPluginSetting`, `EditorBlock`, `editorBlocks`, `storedAs`, `blocksOf`, `withBlock`, `newEditorBlock`, `newBlockWith`, `emptyBlock`, `emptyFaqItem`, `withFaqItem`, `removeFaqItem`, `replaceBlockWith`, `moveBlock`, `withUploadedPicture`, `columnsOf`, `columnsEntry`, `replaceInColumnWith`, `moveInColumn`, `withColumnCount`, `replaceParagraphWith`, `addParagraph`, `removeParagraph`, `blockText`, `runsToText`, `textToRuns`, `ScanHit`, `scanPage`, `needsPhotoConsent`, `SubmittableBlocks`, `submittableBlocks`, `unfinishedStoredBlocks`, `unfinishedWork`
- `apps/web/src/site-admin/prosemirror-runs.ts`: `EditorNode`, `paragraphsFromDocument`, `documentFromParagraphs`, `Caret`, `joinParagraphsBeyond`
- `apps/web/src/site-admin/site-facts-api.ts`: `AssociationFacts`, `AssociationFactsInput`, `fetchAssociationFacts`, `saveAssociationFacts`

## `apps/web/src/sublets`

- `apps/web/src/sublets/ApplyForSubletPanel.tsx`: `ApplyForSubletPanelProps`, `ApplyForSubletPanel`
- `apps/web/src/sublets/OwnSubletsPanel.tsx`: `OwnSubletsPanelProps`, `OwnSubletsPanel`
- `apps/web/src/sublets/SubletQueuePanel.tsx`: `SubletQueuePanelProps`, `SubletQueuePanel`
- `apps/web/src/sublets/SubletStatusChip.tsx`: `SubletStatusChip`
- `apps/web/src/sublets/SubletsScreen.tsx`: `SubletsScreenProps`, `SubletsScreen`
- `apps/web/src/sublets/sublet-failures.ts`: `subletFailureKey`, `scannedSubletParts`

## `apps/web/src/theme`

- `apps/web/src/theme/ColourLegend.tsx`: `ColourLegend`
- `apps/web/src/theme/ThemeModeToggle.tsx`: `ThemeModeToggle`
- `apps/web/src/theme/accent-override.ts`: `setAccentBaseModes`, `applyAccentOverride`, `reapplyAccentOverride`
- `apps/web/src/theme/theme-mode-context.tsx`: `ThemeModeProvider`, `useThemeMode`
- `apps/web/src/theme/theme-mode.ts`: `THEME_MODES`, `ThemeMode`, `DEFAULT_THEME_MODE`, `THEME_MODE_STORAGE_KEY`, `ThemePreferenceStorage`, `browserThemeStorage`, `isThemeMode`, `readStoredThemeMode`, `storeThemeMode`, `applyThemeMode`, `resolveThemeMode`, `initializeThemeMode`
- `apps/web/src/theme/theme-runtime-context.tsx`: `ThemeRuntimeProvider`, `useThemeRuntime`, `useOptionalThemeRuntime`, `useViewVariant`
- `apps/web/src/theme/theme-runtime.ts`: `applyThemeRendering`

## `apps/web/src/themes`

- `apps/web/src/themes/LintFindings.tsx`: `LintFindings`
- `apps/web/src/themes/ThemeComposerScreen.tsx`: `ThemeComposerScreenProps`, `ThemeComposerScreen`
- `apps/web/src/themes/ThemesPanel.tsx`: `ThemesPanel`
- `apps/web/src/themes/ThemesScreen.tsx`: `ThemesScreen`
- `apps/web/src/themes/composer-draft.ts`: `DRAFT_THEME_ID`, `COLOUR_TOKEN_NAMES`, `ComposerGroup`, `composerGroups`, `builtInRendering`, `ComposerDraft`, `pruneOverrides`, `draftRendering`, `draftFindings`
- `apps/web/src/themes/theme-failures.ts`: `failureKey`, `findingsOf`

## `apps/web/src/ui`

- `apps/web/src/ui/BoardZone.tsx`: `BoardAudience`, `BoardMark`, `BoardControls`, `BoardZoneProps`, `BoardZone`
- `apps/web/src/ui/Dialog.tsx`: `DialogProps`, `Dialog`
- `apps/web/src/ui/HoneypotField.tsx`: `HONEYPOT_FIELD`, `HoneypotField`
- `apps/web/src/ui/LoadFailure.tsx`: `LoadFailure`
- `apps/web/src/ui/LockedForm.tsx`: `LockedForm`
- `apps/web/src/ui/NotRecorded.tsx`: `NotRecorded`
- `apps/web/src/ui/Notice.tsx`: `NoticeTone`, `NoticeProps`, `Notice`
- `apps/web/src/ui/OpenBrfLogo.tsx`: `OpenBrfLogo`
- `apps/web/src/ui/Panel.tsx`: `PanelProps`, `Panel`
- `apps/web/src/ui/TwoPressConfirm.tsx`: `TwoPressConfirm`
- `apps/web/src/ui/controls.ts`: `FIELD`, `FIELD_MULTILINE`, `FIELD_DATA`, `LABEL`, `HINT`, `PRIMARY_BUTTON`, `SECONDARY_BUTTON`, `CAUTION_BUTTON`, `QUIET_BUTTON`, `PANEL`
- `apps/web/src/ui/decimal-input.ts`: `decimalFromInput`
- `apps/web/src/ui/file-href.ts`: `fileHref`
- `apps/web/src/ui/money.ts`: `formatAmount`, `normalizeAmount`, `vatRateOf`
- `apps/web/src/ui/save-state.ts`: `SaveState`, `useSaveAction`, `failureMessageKey`, `refusedFields`, `failureMessage`
- `apps/web/src/ui/use-focus-after-lock.ts`: `useFocusAfterLock`
- `apps/web/src/ui/use-now.ts`: `useNow`
- `apps/web/src/ui/use-poll.ts`: `PollAttempt`, `usePoll`
- `apps/web/src/ui/wall-clock.ts`: `toInstant`, `toWallClock`
