import { Inject, Injectable, Logger } from "@nestjs/common";
import type { TFunction } from "i18next";
import {
  isSupportedApiVersion,
  type LocalizedText,
  type PluginActionDeclaration,
  type PluginDeviceRoute,
  type PluginLicenceDeclaration,
  type PluginPermission,
  type PluginPersonalDataCategory,
  type PluginRecipient,
  type PluginSettingsSchema,
  type PluginSettingsValues,
  type PluginViewSection,
  receivingHosts,
  sameRecipientDeclaration,
} from "@openbrf/plugin-sdk";

import { AuditLogService } from "../audit/audit-log.service";
import type { Capability } from "../authorization/capabilities";
import { DEFAULT_RESOURCE_PLUGIN_ID } from "../auth/protected-resource";
import { DeviceTokenService } from "../devices/device-token.service";
import type { AuditChannel } from "../generated/prisma/enums";
import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { JobQueueService, pluginQueuePrefix } from "../jobs/job-queue.service";
import { EntitlementsService } from "../licences/entitlements.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import {
  assertConsistent,
  type ProcessorAgreementInput,
  ProcessorAgreementService,
} from "../data-protection/processor-agreement.service";
import { ProcessorFactsService } from "../data-protection/processor-facts.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import type { ProcessorAgreementState } from "../data-protection/processors";
import { ENV } from "../config/config.module";
import { blankToNull } from "../http/blank-to-null";
import { failureFrames, failureName } from "../logging/failure";
import type { Env } from "../config/env";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { PackageLock } from "../packaging/package-lock";
import { PluginInstallerService } from "./plugin-installer.service";
import {
  type PluginFinding,
  PluginLoaderService,
} from "./plugin-loader.service";
import { sameActionDeclaration, sameDeviceRoutes } from "./plugin-action-gate";
import { PluginRegistryService } from "./plugin-registry.service";
import {
  type SecretSubmission,
  PluginSettingsService,
} from "./plugin-settings.service";
import {
  CatalogEntryNotFoundError,
  PluginApiVersionError,
  PluginEntryDeprecatedError,
  PluginConsentMismatchError,
  PluginRecipientAlreadyRecordedError,
  PluginRecipientRequiredError,
  PluginNotFoundError,
  PluginReservedIdError,
  PluginResourceConflictError,
  PluginSettingsUnavailableError,
  PluginsDisabledError,
} from "./plugin.errors";
import { offeredSection } from "./plugin-view-offer";
import { RestartCoordinator } from "./restart-coordinator.service";

export interface PluginSummary {
  id: string;
  packageName: string;
  version: string;
  enabled: boolean;
  status: string;
  /**
   * What the last failed install threw, in English, for the operator. On a
   * row that failed before failures carried a code, the only reason there is.
   */
  lastError: string | null;
  /**
   * Why the last install failed, as a code and the values its sentence needs,
   * for the screen to say in the reader's language. Null when it did not fail,
   * or failed before codes were recorded.
   */
  failure: { reason: string; detail: Record<string, string | number> } | null;
  /** Whether the plugin's code is running in this process. */
  loaded: boolean;
  permissions: string[];
  personalData: string[];
  /** The declaration the board consented to, canonically. */
  consentedActions: string[];
  /** The ids an administrator has armed, a subset of the above. */
  armedActions: string[];
  installedAt: string;
  hasSettings: boolean;
  view: { module: string; titleKey: string } | null;
}

export interface PluginsOverview {
  /** OPENBRF_PLUGINS_ENABLED. When false nothing is loaded or installable. */
  pluginsEnabled: boolean;
  /**
   * True from the moment an operation that ends in a restart is accepted until
   * this process is replaced.
   */
  restartPending: boolean;
  /**
   * Which process answered: opaque, and different after every restart. The
   * one part of an answer that tells the replacement from the process it
   * replaces.
   */
  processId: string;
  plugins: PluginSummary[];
  /** Every reason a plugin on the volume is not running. */
  findings: PluginFinding[];
}

/** A plugin view the signed-in person may load. */
export interface PluginViewDescriptor {
  id: string;
  titleKey: string;
  module: string;
  /** Same-origin URL of the Module Federation remote entry. */
  remoteEntry: string;
  /**
   * The section of the navigation this person is offered the view in, or null
   * when it is reachable by its address alone. See offeredSection.
   */
  section: PluginViewSection | null;
}

export interface CatalogPluginView {
  id: string;
  packageName: string;
  version: string;
  name: LocalizedText;
  description: LocalizedText;
  homepage: string | null;
  deprecated: boolean;
  apiVersion: number;
  permissions: PluginPermission[];
  personalData: PluginPersonalDataCategory[];
  /** What the plugin proposes the platform be able to do, if anything. */
  actions: PluginActionDeclaration[];
  /**
   * The route that would serve connected-app sign-in, or null for an entry
   * that declares none.
   *
   * On the view because installing it decides something no other part of the
   * declaration does: the route's full URL becomes the one address connected
   * apps sign in to, at most one installed plugin may hold it, and the route
   * stops answering a browser session. A board that is not shown it consents
   * to the rest of the declaration and to that as well.
   */
  oauthProtectedResource: string | null;
  /**
   * Where the plugin connects to outside the instance, with what for and
   * which personal data each receives (ADR 0037). Empty for an entry that
   * declares none, which an index of version 1 never does.
   */
  recipients: PluginRecipient[];
  /**
   * The routes devices reach with a token the board issues (ADR 0031), empty
   * for an entry that declares none. The consent screen names them, because
   * they answer without anybody signing in.
   */
  deviceRoutes: PluginDeviceRoute[];
  /**
   * Whether the entry declares itself an AI package.
   *
   * On the view for the reason the resource is: it decides something the rest
   * of the declaration does not, which channel the plugin's dispatch is
   * recorded on and which surface it reaches.
   */
  ai: boolean;
  /**
   * The licence the plugin reads, or null for an entry that reads none (ADR
   * 0042).
   *
   * On the view because its audiences are a grant: the plugin may present the
   * association's licence to each of them, and the consent screen names them
   * before the board agrees. Echoed in the install request with `released`.
   */
  licence: PluginLicenceDeclaration | null;
  /** The day the release was published; null where it reads no licence. */
  released: string | null;
  /**
   * The licence this release would not be covered by, or null.
   *
   * Set where a licence this instance holds for the entitlement ends its
   * updates before `released`, and no other covers the release: installing it
   * leaves the plugin dormant, and the update screen says so before the board
   * updates. Judged with the entry's own keys and release date, as the plugin
   * would be judged once installed.
   */
  releaseNotCovered: { updatesUntil: string } | null;
  /** False when the entry needs a contract version this host does not have. */
  supported: boolean;
  /** The version currently installed, when there is one. */
  installedVersion: string | null;
  /**
   * What the record of recipients already says about this plugin, or
   * `notRecorded`.
   *
   * The consent step asks where the plugin sends personal data only while
   * nothing is recorded. Reinstalling and updating open the same step, and
   * answering it again would replace a classification the board may have
   * completed since - a signed agreement's date and reference included - with
   * the few facts the step asks for. The classification is kept across
   * uninstalling as well, so this is read from the record rather than from
   * `installedVersion`.
   */
  recipientState: ProcessorAgreementState;
}

export interface PluginSettingsView {
  id: string;
  schema: PluginSettingsSchema | null;
  /** The plain values. A secret field's value is never among them. */
  values: PluginSettingsValues;
  /** The keys of the secret fields that hold a value. */
  secretsSet: string[];
}

export interface InstallRequest {
  id: string;
  /**
   * The catalog version the operator was shown, when the caller shows one.
   * The command-line tool echoes the version it printed, so a release published
   * between the listing and the install is refused rather than recorded as
   * consented. Omitted, the install takes the version the catalog names now.
   */
  expectedVersion?: string;
  /**
   * What the consent screen showed. Echoed back so an entry that changed
   * between browsing and confirming is refused rather than installed on
   * consent the board never gave.
   *
   * The command-line tool echoes the declaration it printed before it acts,
   * so an entry that changed in between is refused there as well. A caller
   * that omits it - a script - is consenting to whatever the catalog says now.
   */
  permissions?: readonly PluginPermission[];
  personalData?: readonly PluginPersonalDataCategory[];
  /**
   * The actions the consent screen showed, echoed back on the same terms.
   *
   * Echoed by the command-line tool, like the two above it.
   */
  actions?: readonly PluginActionDeclaration[];
  /**
   * The route the screen showed as serving connected-app sign-in, or null
   * where it showed none.
   *
   * Null and absent mean the same thing here, unlike the three above: an entry
   * declaring nothing is echoed as nothing, so the two cannot be told apart.
   * Both therefore read as "the screen showed none", which refuses an entry
   * that has since come to declare one.
   */
  oauthProtectedResource?: string | null;
  /**
   * The recipients the screen showed, echoed back on the terms of the
   * permissions, the personal data and the actions, and echoed by the
   * command-line tool like them. Compared by id, origin and categories: the
   * purpose is the plugin's wording and is shown, not consented to.
   */
  recipients?: readonly Pick<
    PluginRecipient,
    "id" | "origin" | "personalData"
  >[];
  /**
   * The device routes the consent screen showed, echoed back on the terms the
   * actions are (ADR 0031).
   */
  deviceRoutes?: readonly PluginDeviceRoute[];
  /**
   * Whether the screen showed the plugin as an AI package.
   *
   * Absent reads as false, for the resource's reason: an entry declaring
   * nothing is echoed as nothing, so absent has to read as "the screen did not
   * show it", which refuses an entry that has since come to declare it.
   */
  ai?: boolean;
  /**
   * The licence the screen showed the plugin reading, and the release date it
   * showed, or null where it showed none.
   *
   * Absent reads as null, for the resource's reason: an entry that has since
   * come to declare a licence, or another audience, is refused rather than
   * installed on a consent that never named them.
   */
  licence?: PluginLicenceDeclaration | null;
  released?: string | null;
  /**
   * What the board answered about where the plugin sends personal data
   * (GDPR art. 28).
   *
   * A plugin is not a processor by default: it runs inside the instance's own
   * process, and code that sends nothing anywhere receives nothing on the
   * association's behalf. So the consent step asks the one question the
   * instance cannot answer for itself - whether this plugin sends personal data
   * outside the instance, and to whom - and the classification follows from the
   * answer.
   *
   * Omitted by the command-line tool, which records no classification: the
   * recipient reads as not recorded until the board answers on the screen.
   *
   * Only for a plugin the record does not yet classify; an answer for one it
   * does is refused.
   */
  processorAgreement?: {
    sendsPersonalDataOutside: boolean;
    recipient?: string;
    classification?: "PROCESSOR" | "INDEPENDENT_CONTROLLER";
    status?: "IN_PLACE" | "PENDING";
    counterparty?: string;
    reference?: string;
    signedOn?: string;
    termsConfirmed?: boolean;
    subProcessorsAuthorised?: boolean;
    subProcessorNote?: string;
    note?: string;
  };
}

/**
 * The admin-facing half of the plugin system.
 *
 * It records what the board consented to and puts a reconcile on the queue; it
 * never touches the data volume itself. Keeping the two apart is what lets the
 * command-line tool drive exactly the same install as the admin screen - both
 * write a row and enqueue the same job - and it is why a crashed install is
 * recoverable: the consent survives independently of the filesystem work.
 */
@Injectable()
export class PluginAdminService {
  private readonly logger = new Logger(PluginAdminService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: PluginRegistryService,
    private readonly loader: PluginLoaderService,
    private readonly installer: PluginInstallerService,
    private readonly catalog: CatalogClient,
    private readonly audit: AuditLogService,
    private readonly restart: RestartCoordinator,
    /*
     * The record of who receives personal data, and the record of what the
     * association processes. A plugin is a recipient and a processing, so
     * installing one writes to both - and removing one ends the processing
     * while leaving the recipient's classification for the board to close.
     */
    private readonly processors: ProcessorAgreementService,
    private readonly processing: ProcessingActivityService,
    private readonly facts: ProcessorFactsService,
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly packageLock: PackageLock,
    private readonly settings: PluginSettingsService,
    private readonly devices: DeviceTokenService,
    /*
     * For the update screen's notice only: whether a licence the instance
     * holds covers a release the catalog offers. It reads the licences and
     * never presents one.
     */
    private readonly entitlements: EntitlementsService,
    /*
     * The queues a plugin's background work waits on, which outlive its row
     * unless they are deleted with it: see {@link clearQueues}.
     */
    private readonly jobs: JobQueueService,
  ) {}

  /**
   * Turns the consent step's answer into a classification.
   *
   * "Sends nothing outside" is the ordinary case and is no processor at all:
   * the plugin runs in the instance's own process, so nothing is handed to
   * anybody. Answering "yes" makes it a recipient, and which kind is the
   * board's own call - a service acting on the association's instructions is a
   * processor, one deciding its own purposes is a controller in its own right.
   *
   * Returns the input rather than writing it, and refuses it with the same
   * rules the art. 28 record applies: `install` asks this before the consent
   * row, so an answer the record would refuse - an independent controller with
   * no reason given, a personal identity number in the recipient or the note -
   * leaves no consent behind that produced no install. The input returned is
   * the one written, so the check and the row cannot disagree.
   */
  private async pluginAgreementInput(
    answer: NonNullable<InstallRequest["processorAgreement"]>,
  ): Promise<ProcessorAgreementInput> {
    let input: ProcessorAgreementInput;

    if (!answer.sendsPersonalDataOutside) {
      /*
       * The instance's own answer rather than the board's, so it is written in
       * the association's language and not the acting user's: the note is
       * stored once and read later by whoever opens the art. 28 record.
       */
      const t = await this.translator();
      input = {
        classification: "NOT_A_PROCESSOR",
        // An emptied note is no note, so the instance's own reason stands in
        // for it rather than an empty one `assertConsistent` refuses.
        note:
          blankToNull(answer.note) ??
          t("dataProtection.processors.seed.pluginLocal"),
      };
    } else {
      const recipient = requiredRecipient(answer);
      // One default, read on every processor-only field below. Two spellings
      // that drifted apart would send `record` a classification and
      // processor-only fields that disagree, and `assertConsistent` would
      // refuse it for a reason the board cannot act on.
      const classification = answer.classification ?? "PROCESSOR";
      const asProcessor = classification === "PROCESSOR";
      // The agreement's own details - its date, its reference, what it says
      // about sub-processors - describe an art. 28(3) contract. An independent
      // controller has none, so an answer that carries them is not recorded
      // against a recipient they cannot describe.
      const signedOn = asProcessor ? blankToNull(answer.signedOn) : null;

      input = {
        classification,
        status: asProcessor ? (answer.status ?? "PENDING") : null,
        counterparty: blankToNull(answer.counterparty) ?? recipient,
        reference: asProcessor ? blankToNull(answer.reference) : null,
        signedOn: signedOn === null ? null : new Date(signedOn),
        termsConfirmed: asProcessor ? (answer.termsConfirmed ?? null) : null,
        subProcessorsAuthorised: asProcessor
          ? (answer.subProcessorsAuthorised ?? null)
          : null,
        subProcessorNote: asProcessor
          ? blankToNull(answer.subProcessorNote)
          : null,
        note: blankToNull(answer.note),
      };
    }

    assertConsistent(input);
    return input;
  }

  /** The association's own language: the record is one document it keeps. */
  private async translator(): Promise<TFunction> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    return this.i18n.translatorFor(association?.defaultLocale);
  }

  async overview(): Promise<PluginsOverview> {
    const records = await this.registry.list();

    return {
      pluginsEnabled: this.env.OPENBRF_PLUGINS_ENABLED,
      restartPending: this.restart.restartPending,
      processId: this.restart.processId,
      findings: this.loader.report(),
      plugins: records.map((record) => {
        const loaded = this.loader.get(record.id);
        const manifest = this.loader.manifestFor(record.id);
        return {
          id: record.id,
          packageName: record.packageName,
          version: record.version,
          enabled: record.enabled,
          status: record.status,
          lastError: record.lastError,
          failure: record.failure,
          loaded: loaded !== null,
          permissions: record.consentedPermissions,
          personalData: record.declaredPersonalData,
          /*
           * What the board agreed this plugin may be asked to do, and which of
           * those an administrator has since switched on beyond this instance.
           * Both are on the screen because they answer different questions:
           * the first is what was consented to, the second is what is live.
           */
          consentedActions: record.consentedActions,
          armedActions: record.armedActions,
          installedAt: record.installedAt.toISOString(),
          hasSettings: manifest?.settingsSchema !== undefined,
          view: manifest?.view ?? null,
        };
      }),
    };
  }

  /**
   * The views a signed-in person may load.
   *
   * Deliberately not derived from the admin overview: a resident has no
   * business reading the install state of the instance, but does need to know
   * which plugin views to render.
   *
   * Every view is listed whoever asks, as it was before a view could name a
   * section, so one is still reachable by its address. Which of them the
   * navigation offers this person is answered per view.
   */
  views(capabilities: ReadonlySet<Capability>): PluginViewDescriptor[] {
    return this.loader.list().flatMap((plugin) => {
      const view = plugin.manifest.view;
      if (view === undefined) {
        return [];
      }
      return [
        {
          id: plugin.id,
          titleKey: view.titleKey,
          module: view.module,
          remoteEntry: `/api/plugins/${plugin.id}/client/remoteEntry.js`,
          section: offeredSection(
            view.section,
            plugin.routeFloor,
            capabilities,
          ),
        },
      ];
    });
  }

  async browseCatalog(): Promise<{
    source: string;
    entries: CatalogPluginView[];
  }> {
    const [catalog, installed, recipients] = await Promise.all([
      this.catalog.read({ refresh: true }),
      this.registry.list(),
      this.processors.forPlugins(),
    ]);
    const byId = new Map(installed.map((record) => [record.id, record]));
    const notCovered = new Map(
      await Promise.all(
        catalog.entries
          .filter(
            (entry): entry is CatalogPluginEntry => entry.type === "plugin",
          )
          .map(
            async (entry) =>
              [entry.id, await this.releaseNotCovered(entry)] as const,
          ),
      ),
    );

    return {
      source: this.catalog.resolveUrl(),
      entries: catalog.entries
        .filter((entry): entry is CatalogPluginEntry => entry.type === "plugin")
        .map((entry) => ({
          id: entry.id,
          packageName: entry.packageName,
          version: entry.version,
          name: entry.name,
          description: entry.description,
          homepage: entry.homepage ?? null,
          deprecated: entry.deprecated,
          apiVersion: entry.apiVersion,
          permissions: entry.permissions,
          // The third part of the declaration the consent screen shows, and the
          // third the install echo compares: omitting it here would leave the
          // browser echoing an empty list against a catalog entry that declares
          // actions, which the echo refuses as a consent mismatch.
          actions: entry.actions,
          personalData: entry.personalData,
          // Null where the entry declares none, rather than left off the view:
          // the browser echoes what the screen showed, and an absent field and
          // a declaration of nothing have to arrive as the same answer for the
          // install to be able to compare them.
          oauthProtectedResource: entry.oauthProtectedResource ?? null,
          // Echoed by the browser with the three lists above, so an entry
          // declaring none is given as an empty list rather than left off.
          recipients: entry.recipients ?? [],
          // An empty list rather than an absent one, for the reason the
          // resource is null: the browser echoes what the screen showed.
          deviceRoutes: entry.deviceRoutes ?? [],
          ai: entry.ai,
          // Null rather than absent, for the resource's reason: the browser
          // echoes what the screen showed.
          licence: entry.licence ?? null,
          released: entry.released ?? null,
          releaseNotCovered: notCovered.get(entry.id) ?? null,
          supported: isSupportedApiVersion(entry.apiVersion),
          installedVersion: byId.get(entry.id)?.version ?? null,
          recipientState: recipients.get(entry.id) ?? "notRecorded",
        })),
    };
  }

  /**
   * The licence a catalog release would not be covered by, judged as the
   * plugin would be once that release is installed: with the entry's keys,
   * its entitlement and its release date (ADR 0042). Null for an entry that
   * reads no licence, and wherever the release is covered or no licence for
   * it is held.
   *
   * Null as well when the judgement fails: the notice is advice, and a licence
   * is never a reason for the catalog, and with it every other plugin's
   * install, not to be served (ADR 0042).
   */
  private async releaseNotCovered(
    entry: CatalogPluginEntry,
  ): Promise<{ updatesUntil: string } | null> {
    if (entry.licence === undefined || entry.released === undefined) {
      return null;
    }
    try {
      const { state } = await this.entitlements.judge({
        licence: entry.licence,
        released: entry.released,
      });
      return state.status === "version-not-covered"
        ? { updatesUntil: state.updatesUntil }
        : null;
    } catch (error) {
      this.logger.warn(
        `Could not judge the licence for catalog entry ${entry.id}: ${error instanceof Error ? error.name : "unknown error"}`,
      );
      return null;
    }
  }

  /**
   * The installed plugin other than this one that declares the OAuth protected
   * resource, or null when none does.
   *
   * The manifest is not on the InstalledPlugin row, so it is read from the
   * loader, which holds one for every package on the volume whether it is
   * running or not. Installed rather than serving is the right set: a disabled
   * connector is still a plugin the board would have to decide about, and
   * switching it back on must not be the act that moves the audience out from
   * under every token already issued.
   *
   * The same plugin id is not a holder. Re-installing and upgrading write the
   * same row, and a connector that could not be upgraded to its own next
   * version would be a connector nobody could ever patch.
   *
   * A row consented in this process whose package has not reached the volume
   * yet carries no manifest anywhere, so a second connector installed between
   * one install and the restart it asked for is not seen here. That pair is
   * caught at the next boot, where the older install keeps the resource and the
   * newcomer is reported as `oauth-resource-conflict`.
   */
  private async resourceHolder(id: string): Promise<string | null> {
    const installed = await this.registry.list();
    const holder = installed.find(
      (record) =>
        record.id !== id &&
        this.loader.manifestFor(record.id)?.oauthProtectedResource !==
          undefined,
    );
    return holder?.id ?? null;
  }

  /**
   * Installs from the catalog.
   *
   * Six gates before anything is written: the entry has to exist, it may not
   * be deprecated unless this instance already has the plugin, its contract
   * version has to be one this host implements, it may take the
   * reserved connector id only by serving the resource that id names, no other
   * installed plugin may already declare that resource, and what the board
   * confirmed has to still match what the catalog says. The last exists because
   * the consent screen and the confirmation are two requests, and a catalog is
   * a file somebody can commit to in between.
   */
  async install(
    request: InstallRequest,
    actorPersonId: string | null,
    channel: AuditChannel,
  ): Promise<{ restarting: boolean }> {
    if (!this.env.OPENBRF_PLUGINS_ENABLED) {
      throw new PluginsDisabledError();
    }

    /*
     * Every gate below reads whether the plugin is already here, and an
     * uninstall of the same id deletes the row they read, so both run under
     * the one lock. See {@link PackageLock}.
     */
    return await this.packageLock.run("plugin", request.id, (lockLost) =>
      this.installLocked(request, actorPersonId, channel, lockLost),
    );
  }

  /**
   * The install, under the lock.
   *
   * Every write below is preceded by a check that the lock is still held. A
   * lock lost part way stops the install at the next write rather than letting
   * it go on beside an uninstall that may already have the id: reopening the
   * processing or queueing the install of a plugin that uninstall has removed
   * is the race the lock is there to close.
   */
  private async installLocked(
    request: InstallRequest,
    actorPersonId: string | null,
    channel: AuditChannel,
    lockLost: AbortSignal,
  ): Promise<{ restarting: boolean }> {
    /*
     * Read from the source rather than the cache: the screen that sent this
     * browsed the catalog up to a minute ago, and a curator who deprecated
     * the entry or changed what it declares since must be seen by the gates
     * below, not by the copy the screen was drawn from.
     */
    const entry = await this.catalog.entry(request.id, { refresh: true });
    if (entry === null || entry.type !== "plugin") {
      throw new CatalogEntryNotFoundError(request.id);
    }
    /*
     * A reinstall or an update of a plugin already here is let through: the
     * row is what says the board chose it, and refusing it would leave a board
     * unable to repair or patch a plugin it already depends on.
     */
    if (entry.deprecated && (await this.registry.find(entry.id)) === null) {
      throw new PluginEntryDeprecatedError(entry.id);
    }
    if (
      request.expectedVersion !== undefined &&
      request.expectedVersion !== entry.version
    ) {
      throw new PluginConsentMismatchError();
    }
    if (!isSupportedApiVersion(entry.apiVersion)) {
      throw new PluginApiVersionError(entry.id, entry.apiVersion);
    }

    /*
     * What the entry declares about the OAuth protected resource, refused here
     * for the reason the version gate is refused here: the index says it, so
     * nothing has to be downloaded to know it, and a board reading the refusal
     * still has the choice in front of it.
     */
    if (
      entry.id === DEFAULT_RESOURCE_PLUGIN_ID &&
      entry.oauthProtectedResource === undefined
    ) {
      throw new PluginReservedIdError(entry.id);
    }
    if (entry.oauthProtectedResource !== undefined) {
      const incumbent = await this.resourceHolder(entry.id);
      if (incumbent !== null) {
        throw new PluginResourceConflictError(entry.id, incumbent);
      }
    }

    /*
     * Any part of the declaration echoed means all of it is compared. A
     * request carrying one field and omitting another would otherwise skip the
     * comparison for the part it left out and install on consent that was
     * never checked - which is why this is an OR over five fields rather than
     * a check per field.
     *
     * The protected resource is compared on the strength of those five rather
     * than joining the OR: it is the one part of the declaration whose absence
     * is itself a value, so an omitted field cannot be read as "not echoed"
     * without letting a request that names nothing skip it. It is read as "the
     * screen showed none" instead, which refuses an install where the entry
     * came to declare one after the screen was drawn - the case that would
     * otherwise hand a plugin the address connected apps sign in to on a
     * consent that never mentioned it.
     *
     * Whether the plugin is an AI package is compared on the same terms, and
     * in both directions: an entry that came to declare it would have its
     * writes recorded as the AI package's on a consent that never said so, and
     * one that stopped declaring it after the screen said so would reach every
     * action offered on this instance's own screens instead of the ones
     * offered to the AI package.
     */
    const echoed =
      request.permissions !== undefined ||
      request.personalData !== undefined ||
      request.actions !== undefined ||
      request.recipients !== undefined ||
      request.deviceRoutes !== undefined;
    const entryRecipients = entry.recipients ?? [];
    const entryDeviceRoutes = entry.deviceRoutes ?? [];
    if (
      echoed &&
      (!sameDeclaration(entry.permissions, request.permissions ?? []) ||
        !sameDeclaration(entry.personalData, request.personalData ?? []) ||
        !sameActionDeclaration(entry.actions, request.actions ?? []) ||
        !sameRecipientDeclaration(entryRecipients, request.recipients ?? []) ||
        !sameDeviceRoutes(entryDeviceRoutes, request.deviceRoutes ?? []) ||
        (entry.oauthProtectedResource ?? null) !==
          (request.oauthProtectedResource ?? null) ||
        entry.ai !== (request.ai ?? false) ||
        !sameLicenceDeclaration(
          entry.licence ?? null,
          request.licence ?? null,
        ) ||
        (entry.released ?? null) !== (request.released ?? null))
    ) {
      throw new PluginConsentMismatchError();
    }
    const recipients = echoed ? (request.recipients ?? []) : entryRecipients;

    /*
     * The confirmed declaration is what is recorded, not the catalog's. The
     * row is the snapshot the loader enforces against the installed manifest
     * at every later boot, so it has to assert exactly what the board was
     * shown and agreed to; recording anything wider would make the row
     * evidence of a consent nobody gave. With no echo - a script calling the
     * API - the catalog entry is what was shown.
     */
    /*
     * Before the first write, and it writes nothing. The recipient answer used
     * to be checked after the consent row was committed, so an answer the
     * art. 28 record refuses - nobody named, no reason for an independent
     * controller, a personal identity number in the note - was answered 400
     * with a consent row already persisted: the instance then claimed a consent
     * that produced no install, no processing activity in the art. 30 record
     * and no classification in the art. 28 one. The command-line tool sends no
     * recipient answer; a direct caller of the API, such as a script, can send
     * one without any screen's checks in front of it.
     *
     * Neither can change a classification the record already holds; see
     * {@link PluginRecipientAlreadyRecordedError}.
     */
    if (
      request.processorAgreement !== undefined &&
      (await this.processors.forPlugins()).has(entry.id)
    ) {
      throw new PluginRecipientAlreadyRecordedError(entry.id);
    }

    const agreement =
      request.processorAgreement === undefined
        ? undefined
        : await this.pluginAgreementInput(request.processorAgreement);

    /*
     * Whether the board consented to an AI package, once, for the row and for
     * the entry. The row is rewritten by a reinstall and deleted by an
     * uninstall, so the entry is where the answer is kept: ADR 0038 leaves
     * which plugins were consented to as AI packages, and when, to the install
     * record and its audit entries.
     */
    const consentedAi = echoed ? (request.ai ?? false) : entry.ai;
    const consentedLicence = echoed
      ? (request.licence ?? null)
      : (entry.licence ?? null);

    /*
     * The consent row, the processing in the art. 30 record, the entry that
     * says who installed it and the recipient's classification commit
     * together or not at all. Update-or-
     * create for the processing, so a plugin removed and installed again reads
     * as running rather than ended: the row was closed with a date, and
     * reinstalling reopens it and refreshes the declared categories while
     * keeping any wording the board has written.
     */
    const consentedRoutes = echoed
      ? (request.deviceRoutes ?? [])
      : entryDeviceRoutes;

    /*
     * A first install under this id starts with no queues. The removal that
     * came before deletes them, but a removal whose deletion failed, or one
     * made before removals deleted anything, leaves a package installed now
     * the jobs and the schedules of the one before it. Before the consent, so
     * an install that cannot clear them writes nothing and can be tried again.
     */
    if ((await this.registry.find(entry.id)) === null) {
      lockLost.throwIfAborted();
      await this.clearQueues(entry.id);
    }

    lockLost.throwIfAborted();
    await this.prisma.$transaction(async (tx) => {
      lockLost.throwIfAborted();
      await this.registry.consent(
        {
          id: entry.id,
          packageName: entry.packageName,
          version: entry.version,
          tarballUrl: entry.artifact.url,
          checksum: entry.artifact.sha512,
          permissions: echoed ? (request.permissions ?? []) : entry.permissions,
          personalData: echoed
            ? (request.personalData ?? [])
            : entry.personalData,
          actions: echoed ? (request.actions ?? []) : entry.actions,
          recipients,
          deviceRoutes: consentedRoutes,
          ai: consentedAi,
          licence: consentedLicence,
        },
        tx,
      );

      /*
       * A republished version that drops a device route takes the tokens
       * issued for it with it (ADR 0031), in the transaction that records the
       * consent, so no token outlives the route the board consented to it for.
       */
      lockLost.throwIfAborted();
      await this.devices.revokeDroppedRoutes(
        entry.id,
        consentedRoutes.map((route) => route.id),
        actorPersonId,
        channel,
        tx,
      );

      /*
       * In the same transaction, so a recipient answer that cannot be written
       * takes the consent with it: a consent committed without it would have
       * no reconcile queued, and a board retrying would be told the plugin was
       * already consented to. It is still a record of its own, written with its
       * own entry, rather than a field of the consent row: the declaration a
       * reinstall compares against is the permissions and the personal data,
       * and a classification recorded beside them would make a board's answer
       * about a mail server look like a change to what the plugin asked for.
       *
       * The recipient is keyed on the plugin id rather than on the installed
       * row, so it survives the reinstall that rewrites that row. The facts are
       * read in the transaction, where the consent row above is already there.
       *
       * Only where the record is still empty: the check above was taken before
       * this transaction, so a classification written in between is kept and
       * this install goes on without its answer rather than being refused.
       */
      if (agreement !== undefined) {
        // The facts are read before the check rather than as an argument after
        // it: a lock lost while they are read would otherwise reach the write.
        // The record reads again before it writes, so it checks as well.
        const facts = await this.facts.read(tx);
        lockLost.throwIfAborted();
        await this.processors.record(
          pluginProcessorKey(entry.id),
          { ...agreement, actorPersonId, channel },
          facts,
          { onlyIfUnrecorded: true, lockLost },
          tx,
        );
      }

      lockLost.throwIfAborted();
      await this.processing.seedPlugin(
        entry.id,
        {
          name: entry.packageName,
          personalDataCategories: [
            ...(echoed ? (request.personalData ?? []) : entry.personalData),
          ],
          // An entry that declares no recipients leaves the record's answer
          // as the board wrote it.
          ...(entry.recipients === undefined
            ? {}
            : { recipients: processingRecipients(recipients) }),
        },
        tx,
      );

      lockLost.throwIfAborted();
      await this.audit.record(
        {
          action: "PLUGIN_INSTALLED",
          channel,
          actorPersonId,
          targetKind: "plugin",
          targetId: entry.id,
          context: {
            version: entry.version,
            permissions: echoed
              ? (request.permissions ?? [])
              : entry.permissions,
            personalData: echoed
              ? (request.personalData ?? [])
              : entry.personalData,
            // Where the board agreed the plugin may connect to, by origin: a
            // fact about the plugin, and nothing about a person.
            recipients: recipients.map((recipient) => recipient.origin),
            ai: consentedAi,
            // What the board consented to the plugin reading and whom it may
            // present it to; the issuer's keys are the manifest's business.
            licence:
              consentedLicence === null
                ? null
                : {
                    entitlement: consentedLicence.entitlement,
                    audiences: consentedLicence.audiences,
                  },
          },
        },
        tx,
      );
    });

    lockLost.throwIfAborted();
    await this.installer.enqueue({
      reason: `install:${entry.id}`,
      restart: true,
    });

    return { restarting: true };
  }

  async uninstall(
    id: string,
    actorPersonId: string | null,
    channel: AuditChannel,
  ): Promise<{ restarting: boolean }> {
    // The same lock an install of this id takes, so the two run one after the
    // other.
    return await this.packageLock.run("plugin", id, (lockLost) =>
      this.uninstallLocked(id, actorPersonId, channel, lockLost),
    );
  }

  /**
   * The uninstall, under the lock, checked before every write for the reason
   * {@link installLocked} is: ending the processing of a plugin an install
   * has just put back would leave the record saying it stopped.
   */
  private async uninstallLocked(
    id: string,
    actorPersonId: string | null,
    channel: AuditChannel,
    lockLost: AbortSignal,
  ): Promise<{ restarting: boolean }> {
    lockLost.throwIfAborted();
    await this.prisma.$transaction(async (tx) => {
      lockLost.throwIfAborted();
      const removed = await this.registry.remove(id, tx);
      if (!removed) {
        throw new PluginNotFoundError(id);
      }

      lockLost.throwIfAborted();
      await this.audit.record(
        {
          action: "PLUGIN_REMOVED",
          channel,
          actorPersonId,
          targetKind: "plugin",
          targetId: id,
        },
        tx,
      );

      /*
       * The processing stops; the row stays with the date it stopped, because
       * the record has to be able to say that the association did this and
       * until when. The recipient's classification is left open deliberately:
       * an agreement covered a period that happened, and closing it is the
       * board's own act on the data protection screen.
       */
      lockLost.throwIfAborted();
      await this.processing.endPlugin(id, tx);
    });

    // Stops serving at once, as switching it off does, rather than at the
    // restart the reconcile ends in - which a failed reconcile never reaches.
    this.loader.unload(id);

    /*
     * And its queues go, now that nothing serving sends to them. The removal
     * has committed and is recorded, so a failure here is logged rather than
     * answered: the next install under this id clears them again before it
     * writes anything.
     */
    try {
      await this.clearQueues(id);
    } catch (cause) {
      this.logger.error(
        `Could not delete the job queues of the removed plugin "${id}" ` +
          `(${failureName(cause)}); the next install under the id deletes them.`,
        failureFrames(cause),
      );
    }

    lockLost.throwIfAborted();
    await this.installer.enqueue({ reason: `remove:${id}`, restart: true });
    // What the overview now says, rather than a constant: with plugins
    // switched off nothing runs the reconcile and nothing is replaced, and a
    // screen told otherwise would wait for a process that never comes.
    return { restarting: this.restart.restartPending };
  }

  /**
   * Deletes the job queues of a plugin id that is not installed: every queue
   * under its prefix, with the jobs waiting there and its cron schedules.
   *
   * What a plugin keeps in its settings and its records goes with its row; its
   * queues are in the job schema and have to be deleted on their own. Left in
   * place, a schedule keeps sending jobs that nothing works, holding whatever
   * the plugin put in them, and the next package installed under the id is
   * handed those jobs and those schedules as though they were its own.
   */
  private async clearQueues(id: string): Promise<void> {
    await this.jobs.deleteQueuesUnder(pluginQueuePrefix(id));
  }

  /**
   * Turns a plugin off without uninstalling it.
   *
   * Takes effect immediately for everything the host controls - its routes
   * answer as though it were not installed, its view disappears, and every
   * host service it holds refuses - without waiting for a restart. Its NestJS
   * providers stay constructed and its code stays in this process until the
   * next boot, which is a property of loading CommonJS at all; what it can
   * reach the association's data through is not.
   */
  /**
   * Arms or disarms one of a plugin's declared actions.
   *
   * The act that exposes an action beyond this instance, and the reason a
   * manifest declaring one changes nothing on its own: adding a channel may
   * never make an existing action reachable, so somebody has to decide, per
   * action, that this plugin may be asked to do this by a connected app.
   *
   * It takes effect at once and needs no restart, because the registry reads
   * the arming at the moment of the call rather than caching it - which is
   * also what makes disarming bite immediately.
   */
  async setActionArmed(
    id: string,
    actionId: string,
    armed: boolean,
    actorPersonId: string,
  ): Promise<void> {
    /*
     * One transaction for the change and the entry that records it. Arming is
     * what puts an action within reach of a connected app, so the log has to be
     * able to answer who did it: a write that committed on its own and an audit
     * entry that then failed would leave the action armed with nobody named for
     * it, and audit_log_entry is the statutory archive the association answers
     * with rather than a convenience.
     */
    await this.prisma.$transaction(async (tx) => {
      const record = await this.registry.setActionArmed(
        id,
        actionId,
        armed,
        tx,
      );
      if (record === null) {
        // Rolls the transaction back, which is what the 404 should mean: the
        // arming was refused, so nothing was written to record.
        throw new PluginNotFoundError(id);
      }

      await this.audit.record(
        {
          action: armed ? "PLUGIN_ACTION_ARMED" : "PLUGIN_ACTION_DISARMED",
          channel: "WEB",
          actorPersonId,
          targetKind: "plugin",
          targetId: id,
          context: { actionId },
        },
        tx,
      );
    });
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    actorPersonId: string,
  ): Promise<{ restarting: boolean }> {
    /*
     * The switch and the entry that records it, in one transaction: a plugin
     * runs with what its install consented to, so who switched it on or off is
     * the question an incident asks, and a change that committed with its entry
     * lost would leave nobody named for it.
     */
    await this.prisma.$transaction(async (tx) => {
      const record = await this.registry.setEnabled(id, enabled, tx);
      if (record === null) {
        throw new PluginNotFoundError(id);
      }
      await this.audit.record(
        {
          action: enabled ? "PLUGIN_ENABLED" : "PLUGIN_DISABLED",
          channel: "WEB",
          actorPersonId,
          targetKind: "plugin",
          targetId: id,
        },
        tx,
      );
    });

    // Disabling takes effect at once: the guard in front of a plugin's routes
    // and the view list both read the loaded set, and both drop the plugin as
    // soon as the row says so. Enabling cannot - the code was never required
    // into this process, and a module cannot be added to a running NestJS
    // application with its controllers - so the process is replaced, exactly
    // as an install does it.
    const needsRestart = enabled && this.loader.get(id) === null;
    if (needsRestart) {
      // The row is already committed; there is no job whose completion has to
      // land first. Not awaited: the coordinator drains the server, and this
      // request is one of the connections it is draining.
      void this.restart.restartWhenCommitted(async () => true);
    } else if (!enabled) {
      this.loader.unload(id);
    }

    return { restarting: needsRestart };
  }

  /**
   * What the settings form is drawn from. A secret field's value is never in
   * it, only whether one is set (ADR 0037).
   */
  async readSettings(id: string): Promise<PluginSettingsView> {
    const record = await this.registry.find(id);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }
    const schema = this.loader.manifestFor(id)?.settingsSchema ?? null;
    if (schema === null) {
      return { id, schema: null, values: {}, secretsSet: [] };
    }

    return { id, schema, ...(await this.settings.forAdmin(id, schema)) };
  }

  /**
   * The board's save: the plain values, and the secrets it replaces or
   * clears. A secret left out of `secrets` is kept as it is, which is how the
   * form saves without ever having held it.
   */
  async writeSettings(
    id: string,
    submission: { values: unknown; secrets: SecretSubmission },
    actorPersonId: string,
  ): Promise<PluginSettingsView> {
    const record = await this.registry.find(id);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }
    const schema = this.loader.manifestFor(id)?.settingsSchema;
    if (schema === undefined) {
      throw new PluginSettingsUnavailableError(id);
    }

    return {
      id,
      schema,
      ...(await this.settings.writeFromAdmin(
        id,
        schema,
        submission,
        actorPersonId,
      )),
    };
  }

  /** Re-runs the reconcile, for the CLI and for a failed install. */
  async reconcile(restart: boolean): Promise<void> {
    await this.installer.enqueue({ reason: "manual", restart });
  }
}

/**
 * Multiset equality.
 *
 * The order the catalog lists a declaration in is not a gate, but a repeated
 * value must not be able to stand in for a missing one: comparing sets would
 * accept ["addressBook:read", "addressBook:read"] as an echo of
 * ["addressBook:read", "mail:send"], which is the confirmation of one
 * permission passing for the confirmation of two.
 */
function sameDeclaration(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/**
 * The declared recipients as the art. 30 record lists them: the host of each
 * one that receives personal data, as the consent screen showed it.
 */
function processingRecipients(
  recipients: readonly Pick<PluginRecipient, "origin" | "personalData">[],
): string | null {
  const hosts = receivingHosts(recipients);
  return hosts === "" ? null : hosts;
}

/**
 * Whether two licence declarations say the same, field by field.
 *
 * The whole declaration rather than the part the boot gate holds the consent
 * to: the screen named the issuer as well, and keys the curator swapped after
 * the screen was drawn are a declaration the board did not read. The audiences
 * and keys in any order, on `sameDeclaration`'s terms.
 */
function sameLicenceDeclaration(
  left: PluginLicenceDeclaration | null,
  right: PluginLicenceDeclaration | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  const keys = (declaration: PluginLicenceDeclaration): string[] =>
    Object.entries(declaration.keys).map(([id, key]) => `${id}=${key}`);
  return (
    left.entitlement === right.entitlement &&
    left.issuer.name === right.issuer.name &&
    left.issuer.url === right.issuer.url &&
    sameDeclaration(keys(left), keys(right)) &&
    sameDeclaration(left.audiences, right.audiences)
  );
}

/**
 * The recipient the board named, or the refusal for having named nobody.
 *
 * GDPR art. 30(1)(d) asks who receives the data, so "somewhere outside" is not
 * an answer a record can carry. Its own error rather than the record's
 * "counterparty-required", so the consent screen can point at the field it
 * asked.
 */
function requiredRecipient(
  answer: NonNullable<InstallRequest["processorAgreement"]>,
): string {
  // An emptied field is no answer, so it does not hide the one given in the
  // other.
  const recipient =
    blankToNull(answer.recipient) ?? blankToNull(answer.counterparty);
  if (recipient === null) {
    throw new PluginRecipientRequiredError();
  }
  return recipient;
}
