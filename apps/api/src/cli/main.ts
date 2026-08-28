#!/usr/bin/env node
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { PROCESS_ROLE_VARIABLE } from "../config/process-role";
import { AppModule } from "../app.module";
import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { CatalogError } from "../packaging/catalog-entry";
import { PluginAdminService } from "../plugins/plugin-admin.service";
import { PluginInstallerService } from "../plugins/plugin-installer.service";
import {
  permissionLabelKey,
  personalDataLabelKey,
} from "../plugins/plugin-labels";
import { PluginRegistryService } from "../plugins/plugin-registry.service";

/**
 * `openbrf` - the command-line half of plugin management.
 *
 * It drives exactly the same install as the admin screen: it writes the
 * consent row and puts the same job on the same queue. The two are not
 * parallel implementations, which is the point - an operator recovering an
 * instance from a terminal must not be running a code path the admin screen
 * never exercises.
 *
 * It also runs the reconcile itself rather than only queueing it, so the
 * command converges even on an instance whose server is not running. When the
 * server IS running, it picks the queued job up, finds the volume already
 * correct, and restarts to load the new code.
 *
 * Output is plain English on stdout. This is an operator tool, not a screen:
 * it is read in a terminal by whoever is administering the instance, and its
 * own prose is not translated. The one exception is the declaration printed
 * before an install, which is read from the application's own translations in
 * the fallback locale: that text is what is being consented to, and it has to
 * be the same statement the consent screen makes rather than a second wording
 * that could drift from it.
 */

const USAGE = `openbrf - Open BRF instance administration

Usage:
  openbrf plugin list                 List the plugins this instance runs
  openbrf plugin add <id>             Install a plugin from the catalog
  openbrf plugin remove <id>          Remove an installed plugin
  openbrf plugin catalog              List what the catalog offers

Options:
  --dry-run    For "add": show what would be installed and stop
  --help       Show this message
`;

async function main(argv: readonly string[]): Promise<number> {
  // Set before the application context is built. The tool shares the server's
  // modules so that installing from a terminal and installing from the admin
  // screen are one operation; this is what stops it from also becoming a job
  // worker or executing plugin code.
  process.env[PROCESS_ROLE_VARIABLE] = "cli";

  const args = argv.filter((argument) => !argument.startsWith("--"));
  const flags = new Set(argv.filter((argument) => argument.startsWith("--")));

  if (flags.has("--help") || args[0] === undefined) {
    console.log(USAGE);
    return flags.has("--help") ? 0 : 1;
  }

  if (args[0] !== "plugin") {
    console.error(`Unknown command "${args[0]}".\n\n${USAGE}`);
    return 1;
  }

  const application = await NestFactory.createApplicationContext(AppModule, {
    // The tool's own output is the interface; Nest's start-up banner would
    // bury a one-line answer under twenty lines of module registration.
    logger: ["warn", "error"],
  });

  try {
    return await run(application, args.slice(1), flags);
  } finally {
    await application.close();
  }
}

async function run(
  application: INestApplicationContext,
  args: readonly string[],
  flags: ReadonlySet<string>,
): Promise<number> {
  const admin = application.get(PluginAdminService);
  const registry = application.get(PluginRegistryService);
  const installer = application.get(PluginInstallerService);
  const i18n = application.get(I18nService);

  switch (args[0]) {
    case "list":
      return listInstalled(registry);
    case "catalog":
      return listCatalog(admin);
    case "add":
      return add(admin, installer, i18n, args[1], flags.has("--dry-run"));
    case "remove":
      return remove(admin, installer, args[1]);
    default:
      console.error(`Unknown plugin command "${args[0] ?? ""}".\n\n${USAGE}`);
      return 1;
  }
}

async function listInstalled(registry: PluginRegistryService): Promise<number> {
  const records = await registry.list();
  if (records.length === 0) {
    console.log("No plugins are installed.");
    return 0;
  }

  for (const record of records) {
    const state = record.enabled ? record.status : `${record.status}, disabled`;
    console.log(`${record.id}  ${record.version}  [${state}]`);
    console.log(`  package      ${record.packageName}`);
    console.log(
      `  permissions  ${record.consentedPermissions.join(", ") || "none"}`,
    );
    console.log(
      `  personal data ${record.declaredPersonalData.join(", ") || "none"}`,
    );
    if (record.lastError !== null) {
      console.log(`  last error   ${record.lastError}`);
    }
  }
  return 0;
}

async function listCatalog(admin: PluginAdminService): Promise<number> {
  const { source, entries } = await admin.browseCatalog();
  console.log(`Catalog: ${source}\n`);

  if (entries.length === 0) {
    console.log("The catalog lists no plugins.");
    return 0;
  }

  for (const entry of entries) {
    const marks = [
      entry.installedVersion === null
        ? null
        : `installed ${entry.installedVersion}`,
      entry.supported ? null : "unsupported api version",
      entry.deprecated ? "deprecated" : null,
    ].filter((mark): mark is string => mark !== null);

    console.log(
      `${entry.id}  ${entry.version}${marks.length === 0 ? "" : `  [${marks.join(", ")}]`}`,
    );
    console.log(`  ${entry.name.en}`);
  }
  return 0;
}

async function add(
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

  console.log(`${entry.name.en} ${entry.version} (${entry.packageName})`);
  console.log(`  ${entry.description.en}`);
  console.log(
    `  may           ${declared(entry.permissions, permissionLabelKey)}`,
  );
  console.log(
    `  personal data ${declared(entry.personalData, personalDataLabelKey)}`,
  );

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

  await admin.install({ id }, null);
  const outcome = await installer.reconcile();

  const failure = outcome.failed.find((entryFailed) => entryFailed.id === id);
  if (failure !== undefined) {
    console.error(`\nInstall failed: ${failure.error}`);
    return 1;
  }

  console.log(
    "\nInstalled. A running application restarts to load it; a stopped one " +
      "loads it at its next start.",
  );
  return 0;
}

async function remove(
  admin: PluginAdminService,
  installer: PluginInstallerService,
  id: string | undefined,
): Promise<number> {
  if (id === undefined) {
    console.error("Name the plugin to remove: openbrf plugin remove <id>");
    return 1;
  }

  await admin.uninstall(id, null);
  await installer.reconcile();

  console.log(`Removed "${id}". A running application restarts to unload it.`);
  return 0;
}

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    if (cause instanceof CatalogError) {
      console.error(cause.message);
    } else {
      console.error(String(cause));
    }
    process.exitCode = 1;
  });
