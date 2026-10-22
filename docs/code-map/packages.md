# Code map: the packages

Generated from the source by `pnpm code-map`; `pnpm lint:guards` fails when it is stale. One section per package under `packages/`: whether it is published, its entry points, and every name each file exports. A name is importable from the package only when an entry point exports it. Change the source and regenerate rather than editing this file.

## `@openbrf/i18n`

Private, in `packages/i18n`. Entry points: `@openbrf/i18n`, `@openbrf/i18n/locales/*.json`.

- `packages/i18n/src/index.ts`: `TranslationSchema`, `defaultNS`, `resources`, `Resources`

## `@openbrf/plugin-sdk`

Published, in `packages/plugin-sdk`. Entry points: `@openbrf/plugin-sdk`.

- `packages/plugin-sdk/src/action-refusal.ts`: `ACTION_ERROR_REASONS`, `ActionErrorReason`, `ActionRefusalTransport`, `ACTION_ERROR_MCP`, `ActionRefusalKind`, `ActionRefusal`, `isActionRefusal`
- `packages/plugin-sdk/src/action-schema.ts`: `isHostZodSchema`, `actionInputJsonSchema`, `actionOutputJsonSchema`
- `packages/plugin-sdk/src/actions.ts`: `ACTION_EFFECTS`, `ActionEffect`, `ACTION_SURFACES`, `ActionSurface`, `ACTION_PERSONAL_DATA`, `ActionPersonalData`, `ACTION_NAME_PATTERN`, `ActionRetry`, `ActionErrorSpec`, `ActionRequest`, `ACTION_CHANNELS`, `ActionChannel`, `ActionPrincipal`, `ActionClient`, `ActionContext`, `ActionDefinition`, `PluginActionRegistration`, `PluginActionFilter`, `ActionSummary`, `ActionWithSchemas`, `PluginActions`
- `packages/plugin-sdk/src/api-version.ts`: `PLUGIN_API_VERSION`, `SUPPORTED_PLUGIN_API_VERSIONS`, `isSupportedApiVersion`
- `packages/plugin-sdk/src/blocks.ts`: `PLUGIN_BLOCK_NAME_PATTERN`, `pluginBlockType`, `PLUGIN_BLOCK_ICONS`, `PluginBlockIcon`, `PLUGIN_BLOCK_CATEGORIES`, `PluginBlockCategory`, `pluginBlockSchema`, `PluginBlockDeclaration`, `pluginBlocksSchema`, `PLUGIN_BLOCK_ELEMENTS`, `PluginBlockElementName`, `PLUGIN_BLOCK_ATTRIBUTES`, `PluginBlockElement`, `PluginBlockNode`, `PluginBlockContent`, `PluginBlockRenderContext`, `PluginBlockAbortSignal`, `PLUGIN_BLOCK_RENDER_TIMEOUT_MS`, `PluginBlockRegistration`, `PluginBlocks`
- `packages/plugin-sdk/src/catalog.ts`: `catalogArtifactSchema`, `CatalogArtifact`, `LocalizedText`, `catalogPluginEntrySchema`, `catalogThemeEntrySchema`, `catalogEntrySchema`, `CatalogPluginEntry`, `CatalogThemeEntry`, `CatalogEntry`, `catalogSchema`, `Catalog`, `CatalogParseResult`, `parseCatalogIndex`
- `packages/plugin-sdk/src/define-plugin.ts`: `definePlugin`
- `packages/plugin-sdk/src/entitlements.ts`: `LICENCE_FORMAT`, `LICENCE_PRESENTATION_FORMAT`, `LICENCE_FILE_MAX_BYTES`, `LICENCE_PRESENTATION_MAX_BYTES`, `EntitlementState`, `EntitlementStatus`, `ENTITLEMENT_STATUSES`, `PluginEntitlements`, `TestEntitlementsOptions`, `createTestEntitlements`, `undeclaredAudienceError`
- `packages/plugin-sdk/src/finances.ts`: `PluginDeliveryReceipt`, `PluginDeliveryReference`, `PluginDeliveryReceiptInput`, `PluginFeeNoticeHolders`, `PluginFeeNotice`, `PluginFeeNotificationSummary`, `PluginFeeNotification`, `PluginMemberChargeParty`, `PluginMemberChargeReason`, `PluginMemberCharge`, `PLUGIN_FINANCE_EVENTS`, `PluginFinanceEventType`, `PluginFinanceEvent`, `PluginFinanceEvents`, `PluginFinances`, `PluginDeliveryRefusedError`
- `packages/plugin-sdk/src/findings.ts`: `PLUGIN_FINDING_REASONS`, `PluginFindingReason`, `PluginFindingDetail`
- `packages/plugin-sdk/src/host.ts`: `PluginPermissionError`, `PluginLogger`, `PluginSettings`, `PluginMailMessage`, `PluginMail`, `PluginSmsMessage`, `PluginSms`, `PluginJobs`, `PluginApartment`, `PluginResident`, `PluginOccupancySummary`, `PluginAddressBook`, `PluginThemeInstallOptions`, `PluginThemeInstallWarning`, `PluginThemeInstallResult`, `PluginInstalledTheme`, `PluginThemes`, `DeviceTokenSummary`, `PluginDevices`, `PluginHost`, `PluginHostUnavailableError`
- `packages/plugin-sdk/src/integrity.ts`: `IntegrityError`, `parseSha512`, `formatSha512`
- `packages/plugin-sdk/src/manifest.ts`: `pluginIdSchema`, `pluginEntrySchema`, `pluginActionSchema`, `pluginActionsSchema`, `declaredActionsSchema`, `composedActionName`, `PLUGIN_VIEW_SECTIONS`, `PluginViewSection`, `pluginViewSchema`, `pluginDeviceRouteSchema`, `MAX_DEVICE_ROUTES`, `routePathsOverlap`, `declaredDeviceRoutesSchema`, `pluginDeviceRoutesSchema`, `deviceRouteRuleIssues`, `isCalendarDay`, `licenceKeyIdSchema`, `licencePublicKeySchema`, `licenceAudienceSchema`, `pluginLicenceSchema`, `PluginLicenceDeclaration`, `pluginManifestSchema`, `PluginManifest`, `PluginActionDeclaration`, `PluginEntry`, `PluginView`, `PluginDeviceRoute`, `RUNTIME_DEPENDENCY_FIELDS`, `dependencyNames`, `isEmptyDependencyField`, `pluginPackageSchema`, `PluginPackage`, `ManifestParseFailure`, `ManifestParseResult`, `parsePluginPackage`, `assertPluginPackage`, `CURRENT_PLUGIN_API_VERSION`
- `packages/plugin-sdk/src/module.ts`: `PluginModuleFactory`
- `packages/plugin-sdk/src/package-check.ts`: `HOST_SHARED_PACKAGES`, `PluginPackageContents`, `pluginPackageProblems`
- `packages/plugin-sdk/src/permissions.ts`: `PLUGIN_PERMISSIONS`, `PluginPermission`, `isPluginPermission`, `PLUGIN_PERSONAL_DATA_CATEGORIES`, `PluginPersonalDataCategory`
- `packages/plugin-sdk/src/records.ts`: `JsonValue`, `PLUGIN_RECORD_COLLECTION_PATTERN`, `PLUGIN_RECORD_KEY_PATTERN`, `PLUGIN_RECORD_LIMITS`, `PluginRecord`, `PluginRecords`, `PluginRecordConflictError`, `PluginRecordLimit`, `PluginRecordLimitError`, `PluginRecordIdentityNumberError`
- `packages/plugin-sdk/src/require-capability.ts`: `REQUIRED_CAPABILITIES_KEY`, `PLUGIN_ROUTE_CAPABILITIES`, `PluginRouteCapability`, `RequireCapability`
- `packages/plugin-sdk/src/settings-schema.ts`: `pluginSettingsFieldSchema`, `PluginSettingsField`, `pluginSettingsSchema`, `PluginSettingsSchema`, `PluginSettingsValues`, `settingsValidator`, `defaultSettings`
- `packages/plugin-sdk/src/standard-schema.ts`: `StandardSchemaV1`, `StandardSchemaResult`, `StandardSchemaIssue`

## `@openbrf/shared`

Private, in `packages/shared`. Entry points: `@openbrf/shared`, `@openbrf/shared/testing`.

- `packages/shared/src/address-book-limits.ts`: `MAX_ADDRESS_BOOK_SEARCH_LENGTH`
- `packages/shared/src/apartment-numbering.ts`: `ENTRANCE_FLOOR_PREFIX`, `MAX_APARTMENTS_PER_FLOOR`, `LOWEST_FLOOR`, `HIGHEST_FLOOR`, `ApartmentNumberingError`, `ApartmentNumberRow`, `GenerateApartmentNumbersInput`, `apartmentNumberFor`, `floorOfApartmentNumber`, `generateApartmentNumbers`
- `packages/shared/src/audit-channels.ts`: `AUDIT_CHANNELS`, `AuditChannelName`
- `packages/shared/src/board-mailbox-limits.ts`: `MAX_REPLY_CHARACTERS`
- `packages/shared/src/calendar-date-schema.ts`: `calendarDateSchema`
- `packages/shared/src/contact-inbox-limits.ts`: `MAX_CONTACT_SUBMISSIONS_PER_REMOVAL`
- `packages/shared/src/data-protection-limits.ts`: `DATA_PROTECTION_LIMITS`
- `packages/shared/src/data-protection.ts`: `PERSONAL_DATA_CATEGORIES`, `PersonalDataCategory`, `DATA_SUBJECT_CATEGORIES`, `DataSubjectCategory`
- `packages/shared/src/data-subject-report-sections.ts`: `DATA_SUBJECT_REPORT_SECTIONS`, `DataSubjectReportSection`
- `packages/shared/src/error-reasons.ts`: `MoveReason`, `AccountingReason`, `FeeReason`, `MemberChargeReason`, `MeetingReason`, `SubletReason`, `SubletTextPart`, `MotionReason`, `MotionTextPart`, `EventReason`, `EventTextField`, `KeyOrderReason`, `KeyOrderTextPart`, `ApartmentBinderReason`, `ApartmentBinderTextPart`, `MediaReason`, `FeedReason`, `PageWriteReason`, `NewsCommentReason`, `BookingReason`, `BookingTextField`, `ConnectedAppRevocationReason`
- `packages/shared/src/feed.ts`: `AudienceKind`, `BOARD_POST_AUDIENCES`, `AuthorView`, `AudienceView`, `AudienceListView`, `PostAudienceView`, `PostNewsView`, `PostImageView`, `PostIssueStatus`, `PostIssueView`, `PostView`, `FeedFrom`, `FeedPage`, `FeedUpdate`, `PostCommentView`, `RevisionView`, `RevisionListView`, `NotReadView`, `PostCommentPage`, `PostCommentUpdate`, `LikeView`, `PostReadView`, `GroupMemberView`, `GroupCandidateView`, `CreatedGroupView`, `PostReportView`, `PostReportQueueView`
- `packages/shared/src/import-limits.ts`: `MAX_IMPORT_UPLOAD_BYTES`, `MAX_IMPORT_ROWS`, `MAX_IMPORT_COLUMNS`, `MAX_IMPORT_CELL_LENGTH`
- `packages/shared/src/index.ts`: `VERSION`, `Result`, `ok`, `err`
- `packages/shared/src/issue-report-limits.ts`: `ISSUE_REPORT_LIMITS`
- `packages/shared/src/loopback-host.ts`: `isLoopbackHost`
- `packages/shared/src/page-blocks/blocks/association-facts.ts`: `AssociationFactsBlock`, `associationFactsBlock`
- `packages/shared/src/page-blocks/blocks/banner.ts`: `BannerBlock`, `bannerBlock`
- `packages/shared/src/page-blocks/blocks/board-roster.ts`: `BoardRosterBlock`, `boardRosterBlock`
- `packages/shared/src/page-blocks/blocks/button.ts`: `BUTTON_STYLES`, `ButtonStyle`, `ButtonBlock`, `buttonBlock`
- `packages/shared/src/page-blocks/blocks/columns.ts`: `NESTED_BLOCKS`, `NestedBlock`, `NestedBlockType`, `Column`, `ColumnsBlock`, `nestedDefinition`, `columnsBlock`
- `packages/shared/src/page-blocks/blocks/controller-contact.ts`: `ControllerContactBlock`, `controllerContactBlock`
- `packages/shared/src/page-blocks/blocks/document-list.ts`: `DocumentListBlock`, `documentListBlock`
- `packages/shared/src/page-blocks/blocks/event-calendar.ts`: `EventCalendarBlock`, `eventCalendarBlock`
- `packages/shared/src/page-blocks/blocks/faq.ts`: `FaqItem`, `FaqBlock`, `faqBlock`
- `packages/shared/src/page-blocks/blocks/forms.ts`: `ContactFormBlock`, `IssueReportFormBlock`, `contactFormBlock`, `issueReportFormBlock`
- `packages/shared/src/page-blocks/blocks/heading.ts`: `HeadingBlock`, `headingBlock`
- `packages/shared/src/page-blocks/blocks/image-text.ts`: `IMAGE_SIDES`, `ImageSide`, `ImageTextBlock`, `imageTextBlock`
- `packages/shared/src/page-blocks/blocks/image.ts`: `ImageBlock`, `imageBlock`
- `packages/shared/src/page-blocks/blocks/news-teaser.ts`: `NewsTeaserBlock`, `newsTeaserBlock`
- `packages/shared/src/page-blocks/blocks/paragraph.ts`: `ParagraphBlock`, `paragraphBlock`
- `packages/shared/src/page-blocks/definition.ts`: `BlockCategory`, `BlockIcon`, `BlockSchema`, `BlockEditorMetadata`, `BlockDefinition`, `defineBlock`, `PageBlockShape`, `CORE_BLOCK_TYPE_PATTERN`, `NAMESPACED_BLOCK_TYPE_PATTERN`, `NamespacedBlockType`, `isNamespacedBlockType`, `UnregisteredBlock`
- `packages/shared/src/page-blocks/every-string.ts`: `everyStringText`
- `packages/shared/src/page-blocks/link-target.ts`: `LinkTarget`, `BUILT_IN_PAGES`, `BuiltInPage`, `ButtonLink`, `HTTPS_PATTERN`, `isHttpsUrl`, `VISIBLE_TEXT`, `linkTargetSchema`, `buttonLinkFields`, `readLinkTarget`, `readButtonLink`, `normalizeButtonLink`, `isButtonLinkStarted`, `buttonLinkText`
- `packages/shared/src/page-blocks/plugin-blocks.ts`: `PluginBlockSettingValue`, `PluginBlockSettings`, `PluginBlock`, `PluginBlockField`, `PluginBlockDeclaration`, `PluginBlockDefinition`, `pluginBlockDefinition`, `readPluginBlockSettings`
- `packages/shared/src/page-blocks/registry.ts`: `CORE_BLOCKS`, `BlockOf`, `CoreBlock`, `CoreBlockType`, `PageBlock`, `BlockRegistry`, `createBlockRegistry`, `PAGE_BLOCKS`, `serializeUnregistered`
- `packages/shared/src/page-blocks/text-runs.ts`: `Zod`, `TextRun`, `LINK_PATTERN`, `isPublishableUrl`, `runsSchema`, `keptRuns`, `readRuns`, `readRunList`, `wordsOnly`, `isRecord`
- `packages/shared/src/page-content-limits.ts`: `PAGE_CONTENT_LIMITS`
- `packages/shared/src/page-slug.ts`: `PAGE_SLUG_MAX_LENGTH`, `PAGE_SLUG_FALLBACK`, `slugFromTitle`, `numberedSlug`
- `packages/shared/src/personal-identity-number.ts`: `PersonalIdentityNumberParts`, `parsePersonalIdentityNumber`, `normalizePersonalIdentityNumber`, `personalIdentityNumberNeedsCentury`, `withPersonalIdentityNumberCentury`, `isValidPersonalIdentityNumber`, `PersonalIdentityNumberMatch`, `normalizeFreeText`, `normalizeSingleLineText`, `scanForPersonalIdentityNumbers`, `scanForPersonalIdentityNumberCandidates`
- `packages/shared/src/plugin-install-failures.ts`: `PLUGIN_INSTALL_FAILURE_REASONS`, `PluginInstallFailureReason`, `PluginInstallFailureDetail`, `pluginInstallFailureValues`, `pluginInstallFailureReason`
- `packages/shared/src/redirect-uri.ts`: `isAcceptableRedirectUri`
- `packages/shared/src/scannable-text.ts`: `ScannableRun`, `ScannableText`, `scannableRuns`
- `packages/shared/src/settings-limits.ts`: `HOUSING_COOPERATIVE_LIMITS`, `FINANCE_LIMITS`, `SMS_LIMITS`, `ADDRESS_LIMITS`, `BOOKABLE_RESOURCE_LIMITS`, `ISSUE_TYPE_LIMITS`, `ADMINISTRATOR_LIMITS`, `MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_LENGTH`
- `packages/shared/src/site-stylesheet.ts`: `SITE_DOCUMENT_STYLESHEET`, `SITE_LAYOUT_STYLESHEET`
- `packages/shared/src/stockholm-calendar.ts`: `ASSOCIATION_TIME_ZONE`, `MINUTES_PER_DAY`, `LocalDay`, `Period`, `instantAt`, `localDayOf`, `localMinuteOf`, `dateColumnOf`, `localDayOfColumn`, `formatDateColumn`, `formatDayOfInstant`, `addLocalDays`, `compareLocalDays`, `localDaysBetween`, `formatLocalDay`, `parseLocalDay`, `localWeekAround`
- `packages/shared/src/support-access-limits.ts`: `SUPPORT_ACCESS_HOURS`, `SupportAccessHours`, `SUPPORT_REASON_MAX_LENGTH`
- `packages/shared/src/testing/personal-identity-number.ts`: `testPersonalIdentityNumber`

## `@openbrf/theme-tools`

Published, in `packages/theme-tools`. Entry points: `@openbrf/theme-tools`.

- `packages/theme-tools/src/archive.ts`: `MAX_ARCHIVE_ENTRIES`, `MAX_ENTRY_BYTES`, `MAX_TOTAL_BYTES`, `MAX_DIRECTORY_RECORDS`, `MAX_TARBALL_BYTES`, `ThemeArchiveError`, `ThemeArchiveFiles`, `readThemeArchive`, `writeThemeArchive`
- `packages/theme-tools/src/fonts.ts`: `cssFontStyle`, `cssFontWeight`, `cssString`, `ThemeFontFaceSource`, `themeFontFaces`, `buildFontFaceStylesheet`
- `packages/theme-tools/src/inherit.ts`: `ThemeChainEntry`, `ThemeLookup`, `BUILT_IN_THEME`, `ChainResult`, `resolveThemeChain`, `mergeChain`, `unknownTokenNames`, `ResolvedThemeModes`, `resolveChainTokens`
- `packages/theme-tools/src/lint.ts`: `ThemeLintRule`, `ThemeLintSeverity`, `ThemeLintFinding`, `ThemeLintInput`, `ThemeLintResult`, `THEME_MANIFEST_FILE`, `lintTheme`, `AA_CONTRAST_RATIO`, `chainEntryFor`
- `packages/theme-tools/src/manifest.ts`: `BUILT_IN_THEME_ID`, `isPackagePath`, `themeFontDeclarationSchema`, `themeManifestSchema`, `ThemeManifest`, `ThemeFontDeclaration`, `KNOWN_MANIFEST_FIELDS`, `ManifestParseResult`, `parseThemeManifest`
- `packages/theme-tools/src/package.ts`: `ThemePackage`, `ReadThemePackageResult`, `readThemePackage`, `lintThemeAgainst`, `LintThemePackageResult`, `lintThemePackage`
- `packages/theme-tools/src/semver-range.ts`: `SemanticVersion`, `parseVersion`, `isVersion`, `compareVersions`, `isRange`, `satisfiesRange`
- `packages/theme-tools/src/view-variants.ts`: `ViewVariantSlot`, `VIEW_VARIANT_SLOTS`, `ViewVariantSlotName`, `viewVariantSlot`, `ViewVariantSelection`, `ViewVariantProblem`, `viewVariantProblems`, `resolveViewVariant`

## `@openbrf/tokens`

Published, in `packages/tokens`. Entry points: `@openbrf/tokens`.

- `packages/tokens/src/branding.ts`: `ACCENT_TOKEN_NAMES`, `AccentTokenName`, `AccentFamily`, `AccentOverride`, `MAX_INK_MIX`, `AccentSurface`, `AccentDerivation`, `BrandingProblem`, `BrandingResult`, `mixColors`, `normalizeColor`, `pushToContrast`, `deriveAccentFamily`, `primaryColorOverride`, `buildAccentOverrideStylesheet`
- `packages/tokens/src/contract.ts`: `TOKEN_CONTRACT_VERSION`, `TOKEN_PREFIX`, `TokenDefinition`, `TOKENS`, `TokenName`, `TokenSet`, `PartialTokenSet`, `TOKEN_NAMES`, `REQUIRED_TOKEN_NAMES`, `tokenDefinition`, `cssVariableName`, `ContrastPair`, `CONTRAST_PAIRS`
- `packages/tokens/src/contrast.ts`: `AA_CONTRAST_RATIO`, `parseColor`, `relativeLuminance`, `contrastRatio`, `ContrastFinding`, `checkContrast`
- `packages/tokens/src/porttavlan.ts`: `PORTTAVLAN_ID`, `PORTTAVLAN_LIGHT`, `PORTTAVLAN_DARK`, `ThemeModes`, `PORTTAVLAN`, `DEFAULT_THEME_MODES`
- `packages/tokens/src/resolve.ts`: `ResolveResult`, `resolveTokens`, `TokenValueError`, `TOKEN_VALUE_PROBLEM_CODES`, `TokenValueProblemCode`, `tokenValueProblem`, `tokenValueProblemCode`, `tokensToCssDeclarations`, `buildThemeStylesheet`
