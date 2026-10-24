import { recipientHost } from "@openbrf/plugin-sdk";

import { FALLBACK_LOCALE, type I18nService } from "../i18n/i18n.service";
import type { PluginAdminService } from "../plugins/plugin-admin.service";
import type { PluginInstallerService } from "../plugins/plugin-installer.service";
import {
  permissionLabelKey,
  personalDataLabelKey,
} from "../plugins/plugin-labels";
import { deviceRouteLines } from "./device-route-lines";
import { extensionLines } from "./extension-lines";
import { personRecordsLines } from "./person-records-lines";
import { processingLines } from "./processing-lines";
import { terminalText } from "./terminal-text";

/**
 * `openbrf plugin add <id> [--dry-run]`.
 *
 * Prints the catalog entry's declaration, then installs it on the same
 * service the admin screen installs through, echoing back what it printed. A
 * dry run prints the same declaration and stops.
 *
 * Its own module so that what the operator reads before an install can be
 * tested against what the install is sent. The short labels and the messages
 * came with it from `main.ts` as they were, English still under the note
 * there; the declaration's sentences are the consent screen's translations.
 */
export async function addPlugin(
  admin: PluginAdminService,
  installer: PluginInstallerService,
  i18n: I18nService,
  id: string | undefined,
  dryRun: boolean,
): Promise<number> {
  if (id === undefined) {
    console.error("Name the plugin to install: openbrf plugin add <id>");
    return 1;
  }

  const { entries } = await admin.browseCatalog();
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    console.error(`The catalog does not list "${id}".`);
    return 1;
  }

  /*
   * Printed before anything is written. Running the command is the consent,
   * and consent given without seeing what is being agreed to is not consent -
   * which is why the permissions and the personal-data categories are printed
   * as the sentences the consent screen shows rather than as the identifiers
   * they are keyed by. "addressBook:readContact" does not tell anyone that
   * agreeing to it hands over every resident's email address.
   */
  const t = i18n.translatorFor(FALLBACK_LOCALE);
  const declared = (
    values: readonly string[],
    key: (value: string) => string,
  ) =>
    values.length === 0
      ? "none"
      : values.map((value) => t(key(value))).join("; ");

  // Refused before the consent is printed, as the install would refuse it: a
  // dry run that passes must mean the real run gets past the catalog.
  if (entry.deprecated && entry.installedVersion === null) {
    console.error(
      `The catalog has deprecated ${id}, so it can only be reinstalled or ` +
        "updated where it is already installed.",
    );
    return 1;
  }

  console.log(
    terminalText(`${entry.name.en} ${entry.version} (${entry.packageName})`),
  );
  console.log(`  ${terminalText(entry.description.en)}`);
  console.log(
    `  may           ${declared(entry.permissions, permissionLabelKey)}`,
  );
  console.log(
    `  personal data ${declared(entry.personalData, personalDataLabelKey)}`,
  );
  // What the processing of that data is for, on what basis, for how long and
  // about whom: what the install seeds the record of processing activities
  // with and echoes back below, so the operator reads it first (ADR 0035).
  for (const line of processingLines(entry, t)) {
    console.log(line);
  }
  // What it keeps about a person, for how long, and that the host erases and
  // reports it (ADR 0047): echoed back below with the personal data.
  for (const line of personRecordsLines(entry.personRecords, t, (values) =>
    declared(values, personalDataLabelKey),
  )) {
    console.log(line);
  }
  // What it offers other plugins and what it extends (ADR 0030), each with
  // the categories that cross, so a consent given here covers what the
  // consent screen's does.
  for (const line of extensionLines(entry, t, (values) =>
    declared(values, personalDataLabelKey),
  )) {
    console.log(line);
  }
  // Reached without anybody signing in, by a device holding a token the board
  // issues (ADR 0031), so the operator reads them before consenting.
  for (const line of deviceRouteLines(entry.deviceRoutes, t)) {
    console.log(line);
  }
  // Where it connects to, and what each place receives: the half of the
  // declaration the recipient question on the admin screen is answered from,
  // which the operator reads here instead (ADR 0037). An empty list is only
  // what the entry declares - one listed in version 1 of the index cannot
  // declare any - and not a statement about what the plugin does.
  console.log(
    `  connects to   ${
      entry.recipients.length === 0
        ? t("plugins.consent.recipients.notDeclared")
        : entry.recipients
            .map(
              (recipient) =>
                `${terminalText(recipientHost(recipient.origin))} (${
                  recipient.personalData.length === 0
                    ? t("plugins.consent.recipients.noPersonalData")
                    : declared(recipient.personalData, personalDataLabelKey)
                })`,
            )
            .join("; ")
    }`,
  );
  // Only where declared, as on the consent screen: a plugin that is no AI
  // package has not raised the question.
  if (entry.ai) {
    console.log(
      `  AI package    ${t("plugins.consent.ai.model")} ` +
        `${t("plugins.consent.ai.reach")} ${t("plugins.consent.ai.audit")}`,
    );
  }
  // The same sentences the consent screen shows: a licence the plugin needs,
  // and each service it may present the association's licence to (ADR 0042).
  if (entry.licence !== null) {
    const named = {
      entitlement: entry.licence.entitlement,
      issuer: entry.licence.issuer.name,
    };
    console.log(
      terminalText(
        `  licence       ${t("plugins.consent.licence.needs", named)}`,
      ),
    );
    for (const audience of entry.licence.audiences) {
      console.log(
        terminalText(
          `                ${t("plugins.consent.licence.audience", { ...named, audience })}`,
        ),
      );
    }
    if (entry.releaseNotCovered !== null && entry.released !== null) {
      console.log(
        terminalText(
          `                ${t("plugins.consent.licence.notCovered", {
            updatesUntil: entry.releaseNotCovered.updatesUntil,
            released: entry.released,
          })}`,
        ),
      );
    }
  }

  if (!entry.supported) {
    console.error(
      `\nThis plugin is built against plugin API version ${String(entry.apiVersion)}, ` +
        "which this version of Open BRF does not implement.",
    );
    return 1;
  }

  if (dryRun) {
    console.log("\nDry run: nothing was installed.");
    return 0;
  }

  // The install reads the catalog afresh, so an entry a curator changed since
  // it was listed above is refused rather than installed on a consent that
  // described the older text.
  await admin.install(
    {
      id,
      expectedVersion: entry.version,
      permissions: entry.permissions,
      personalData: entry.personalData,
      actions: entry.actions,
      oauthProtectedResource: entry.oauthProtectedResource,
      extensionPoints: entry.extensionPoints,
      extends: entry.extends,
      recipients: entry.recipients,
      deviceRoutes: entry.deviceRoutes,
      ai: entry.ai,
      licence: entry.licence,
      released: entry.released,
      processing: entry.processing,
      personRecords: entry.personRecords,
    },
    null,
    "SYSTEM",
  );
  const outcome = await installer.reconcile();

  const failure = outcome.failed.find((entryFailed) => entryFailed.id === id);
  if (failure !== undefined) {
    console.error(`\nInstall failed: ${terminalText(failure.error)}`);
    return 1;
  }

  console.log(
    "\nInstalled. A running application restarts to load it; a stopped one " +
      "loads it at its next start.",
  );
  return 0;
}
