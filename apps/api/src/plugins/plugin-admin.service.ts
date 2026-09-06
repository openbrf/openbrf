import { Inject, Injectable } from "@nestjs/common";
import type { TFunction } from "i18next";
import {
  isSupportedApiVersion,
  type PluginPermission,
  type PluginPersonalDataCategory,
  type PluginSettingsSchema,
  type PluginSettingsValues,
  settingsValidator,
} from "@openbrf/plugin-sdk";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import { ProcessorAgreementService } from "../data-protection/processor-agreement.service";
import { ProcessorFactsService } from "../data-protection/processor-facts.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { PluginInstallerService } from "./plugin-installer.service";
import {
  type PluginFinding,
  PluginLoaderService,
} from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import {
  CatalogEntryNotFoundError,
  PluginApiVersionError,
  PluginConsentMismatchError,
  PluginRecipientRequiredError,
  PluginNotFoundError,
  PluginSettingsUnavailableError,
  PluginsDisabledError,
} from "./plugin.errors";
import { RestartCoordinator } from "./restart-coordinator.service";

export interface PluginSummary {
  id: string;
  packageName: string;
  version: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  /** Whether the plugin's code is running in this process. */
  loaded: boolean;
  permissions: string[];
  personalData: string[];
  installedAt: string;
  hasSettings: boolean;
  view: { module: string; titleKey: string } | null;
}

export interface PluginsOverview {
  /** OPENBRF_PLUGINS_ENABLED. When false nothing is loaded or installable. */
  pluginsEnabled: boolean;
  /** True once an install has asked for the process to be replaced. */
  restartPending: boolean;
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
}

export interface CatalogPluginView {
  id: string;
  packageName: string;
  version: string;
  name: { sv: string; en: string };
  description: { sv: string; en: string };
  homepage: string | null;
  deprecated: boolean;
  apiVersion: number;
  permissions: PluginPermission[];
  personalData: PluginPersonalDataCategory[];
  /** False when the entry needs a contract version this host does not have. */
  supported: boolean;
  /** The version currently installed, when there is one. */
  installedVersion: string | null;
}

export interface PluginSettingsView {
  id: string;
  schema: PluginSettingsSchema | null;
  values: PluginSettingsValues;
}

export interface InstallRequest {
  id: string;
  /**
   * What the consent screen showed. Echoed back so an entry that changed
   * between browsing and confirming is refused rather than installed on
   * consent the board never gave.
   *
   * Omitted by the command-line tool, where running the command is itself the
   * consent and there is no earlier screen for the catalog to have changed
   * since. The tool prints the declaration before it acts.
   */
  permissions?: readonly PluginPermission[];
  personalData?: readonly PluginPersonalDataCategory[];
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
  ) {}

  /**
   * Turns the consent step's answer into a classification.
   *
   * "Sends nothing outside" is the ordinary case and is no processor at all:
   * the plugin runs in the instance's own process, so nothing is handed to
   * anybody. Answering "yes" makes it a recipient, and which kind is the
   * board's own call - a service acting on the association's instructions is a
   * processor, one deciding its own purposes is a controller in its own right.
   */
  private async recordPluginProcessor(
    pluginId: string,
    answer: NonNullable<InstallRequest["processorAgreement"]>,
    context: { actorPersonId: string | null },
  ): Promise<void> {
    const facts = await this.facts.read();

    if (!answer.sendsPersonalDataOutside) {
      /*
       * The instance's own answer rather than the board's, so it is written in
       * the association's language and not the acting user's: the note is
       * stored once and read later by whoever opens the art. 28 record.
       */
      const t = await this.translator();
      await this.processors.record(
        pluginProcessorKey(pluginId),
        {
          classification: "NOT_A_PROCESSOR",
          note: answer.note ?? t("dataProtection.processors.seed.pluginLocal"),
          actorPersonId: context.actorPersonId,
        },
        facts,
      );
      return;
    }

    const recipient = requiredRecipient(answer);
    // One default, read four times below. Two spellings that drifted apart
    // would send `record` a classification and processor-only fields that
    // disagree, and `assertConsistent` would refuse it for a reason the board
    // cannot act on.
    const classification = answer.classification ?? "PROCESSOR";
    const asProcessor = classification === "PROCESSOR";

    await this.processors.record(
      pluginProcessorKey(pluginId),
      {
        classification,
        status: asProcessor ? (answer.status ?? "PENDING") : null,
        counterparty: answer.counterparty ?? recipient,
        reference: answer.reference ?? null,
        signedOn: answer.signedOn == null ? null : new Date(answer.signedOn),
        termsConfirmed: asProcessor ? (answer.termsConfirmed ?? null) : null,
        subProcessorsAuthorised: asProcessor
          ? (answer.subProcessorsAuthorised ?? null)
          : null,
        subProcessorNote: answer.subProcessorNote ?? null,
        note: answer.note ?? null,
        actorPersonId: context.actorPersonId,
      },
      facts,
    );
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
      restartPending: this.restart.restartRequested,
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
          loaded: loaded !== null,
          permissions: record.consentedPermissions,
          personalData: record.declaredPersonalData,
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
   */
  views(): PluginViewDescriptor[] {
    return this.loader
      .list()
      .filter((plugin) => plugin.manifest.view !== undefined)
      .map((plugin) => ({
        id: plugin.id,
        titleKey: plugin.manifest.view?.titleKey ?? "",
        module: plugin.manifest.view?.module ?? "./View",
        remoteEntry: `/api/plugins/${plugin.id}/client/remoteEntry.js`,
      }));
  }

  async browseCatalog(): Promise<{
    source: string;
    entries: CatalogPluginView[];
  }> {
    const [catalog, installed] = await Promise.all([
      this.catalog.read({ refresh: true }),
      this.registry.list(),
    ]);
    const byId = new Map(installed.map((record) => [record.id, record]));

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
          personalData: entry.personalData,
          supported: isSupportedApiVersion(entry.apiVersion),
          installedVersion: byId.get(entry.id)?.version ?? null,
        })),
    };
  }

  /**
   * Installs from the catalog.
   *
   * Three gates before anything is written: the entry has to exist, its
   * contract version has to be one this host implements, and what the board
   * confirmed has to still match what the catalog says. The third exists
   * because the consent screen and the confirmation are two requests, and a
   * catalog is a file somebody can commit to in between.
   */
  async install(
    request: InstallRequest,
    actorPersonId: string | null,
  ): Promise<{ restarting: boolean }> {
    if (!this.env.OPENBRF_PLUGINS_ENABLED) {
      throw new PluginsDisabledError();
    }

    const entry = await this.catalog.entry(request.id);
    if (entry === null || entry.type !== "plugin") {
      throw new CatalogEntryNotFoundError(request.id);
    }
    if (!isSupportedApiVersion(entry.apiVersion)) {
      throw new PluginApiVersionError(entry.id, entry.apiVersion);
    }
    // Either both halves of the declaration are echoed or neither is. A
    // request carrying one field and omitting the other would otherwise skip
    // the comparison for the half it left out and install on consent that was
    // never checked.
    const echoed =
      request.permissions !== undefined || request.personalData !== undefined;
    if (
      echoed &&
      (!sameDeclaration(entry.permissions, request.permissions ?? []) ||
        !sameDeclaration(entry.personalData, request.personalData ?? []))
    ) {
      throw new PluginConsentMismatchError();
    }

    /*
     * The confirmed declaration is what is recorded, not the catalog's. The
     * row is the snapshot the loader enforces against the installed manifest
     * at every later boot, so it has to assert exactly what the board was
     * shown and agreed to; recording anything wider would make the row
     * evidence of a consent nobody gave. With no echo - the command-line tool,
     * where running the command is the consent and the declaration was printed
     * first - the catalog entry is what was shown.
     */
    /*
     * Before the first write, and it needs nothing from the database. The
     * recipient check used to run after the consent row was committed, so a
     * board that ticked "sends personal data outside" and named nobody was
     * answered 400 with a consent row already persisted: the instance then
     * claimed a consent that produced no install, no processing activity in the
     * art. 30 record and no classification in the art. 28 one.
     */
    if (request.processorAgreement?.sendsPersonalDataOutside === true) {
      requiredRecipient(request.processorAgreement);
    }

    await this.registry.consent({
      id: entry.id,
      packageName: entry.packageName,
      version: entry.version,
      tarballUrl: entry.artifact.url,
      checksum: entry.artifact.sha512,
      permissions: echoed ? (request.permissions ?? []) : entry.permissions,
      personalData: echoed ? (request.personalData ?? []) : entry.personalData,
    });

    /*
     * After the consent row, and deliberately outside it: the declaration a
     * reinstall compares against is the permissions and the personal data, and
     * a classification recorded beside them would make a board's answer about
     * a mail server look like a change to what the plugin asked for.
     *
     * The recipient is keyed on the plugin id rather than on the installed row,
     * so it survives the reinstall that rewrites that row.
     */
    if (request.processorAgreement !== undefined) {
      await this.recordPluginProcessor(entry.id, request.processorAgreement, {
        actorPersonId,
      });
    }

    /*
     * And the processing itself, in the art. 30 record. Update-or-create, so a
     * plugin removed and installed again reads as running rather than ended:
     * the row was closed with a date, and reinstalling reopens it and refreshes
     * the declared categories while keeping any wording the board has written.
     */
    await this.processing.seedPlugin(entry.id, {
      name: entry.packageName,
      personalDataCategories: [
        ...(echoed ? (request.personalData ?? []) : entry.personalData),
      ],
    });

    await this.audit.record({
      action: "PLUGIN_INSTALLED",
      actorPersonId,
      targetKind: "plugin",
      targetId: entry.id,
      context: {
        version: entry.version,
        permissions: entry.permissions,
        personalData: entry.personalData,
      },
    });

    await this.installer.enqueue({
      reason: `install:${entry.id}`,
      restart: true,
    });

    return { restarting: true };
  }

  async uninstall(
    id: string,
    actorPersonId: string | null,
  ): Promise<{ restarting: boolean }> {
    const removed = await this.registry.remove(id);
    if (!removed) {
      throw new PluginNotFoundError(id);
    }

    await this.audit.record({
      action: "PLUGIN_REMOVED",
      actorPersonId,
      targetKind: "plugin",
      targetId: id,
    });

    /*
     * The processing stops; the row stays with the date it stopped, because
     * the record has to be able to say that the association did this and until
     * when. The recipient's classification is left open deliberately: an
     * agreement covered a period that happened, and closing it is the board's
     * own act on the data protection screen.
     */
    await this.processing.endPlugin(id);

    await this.installer.enqueue({ reason: `remove:${id}`, restart: true });
    return { restarting: true };
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
  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ restarting: boolean }> {
    const record = await this.registry.setEnabled(id, enabled);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }

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

  async readSettings(id: string): Promise<PluginSettingsView> {
    const record = await this.registry.find(id);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }
    const schema = this.loader.manifestFor(id)?.settingsSchema ?? null;
    if (schema === null) {
      return { id, schema: null, values: {} };
    }

    const parsed = settingsValidator(schema).safeParse(record.settings);
    return {
      id,
      schema,
      values: parsed.success ? parsed.data : {},
    };
  }

  async writeSettings(
    id: string,
    values: unknown,
  ): Promise<PluginSettingsView> {
    const record = await this.registry.find(id);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }
    const schema = this.loader.manifestFor(id)?.settingsSchema;
    if (schema === undefined) {
      throw new PluginSettingsUnavailableError(id);
    }

    // Throws a ZodError, which the domain exception filter answers as a 400
    // listing the failing fields.
    const parsed = settingsValidator(schema).parse(values);
    await this.registry.writeSettings(id, parsed);
    return { id, schema, values: parsed };
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
 * The recipient the board named, or the refusal for having named nobody.
 *
 * GDPR art. 30(1)(d) asks who receives the data, so "somewhere outside" is not
 * an answer a record can carry. Asked before anything is written and again
 * where the row is built, from one definition, so the two cannot disagree.
 */
function requiredRecipient(
  answer: NonNullable<InstallRequest["processorAgreement"]>,
): string {
  const recipient = answer.recipient ?? answer.counterparty;
  if (recipient === undefined || recipient.trim() === "") {
    throw new PluginRecipientRequiredError();
  }
  return recipient;
}
