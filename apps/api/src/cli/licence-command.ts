import { readFile } from "node:fs/promises";

import type { INestApplicationContext } from "@nestjs/common";
import type { EntitlementState } from "@openbrf/plugin-sdk";

import {
  LicenceAdminService,
  type LicenceView,
} from "../licences/licence-admin.service";
import { LicenceRefusedError } from "../licences/licence.errors";
import { InstanceIdentityService } from "../licences/instance-identity.service";
import { terminalText } from "./terminal-text";

/**
 * `openbrf licence list|add <file>|remove <id>|replace-key <reason>`
 * (ADR 0042).
 *
 * The same service as the licence screen, so a file an operator enters from a
 * terminal is checked, stored and logged as one the board enters. The tool
 * runs no plugin's code: it reads the installed plugins' manifests from the
 * volume, which is where the keys a licence is verified with are declared.
 *
 * Replacing the instance key is here and on no screen or route: it is the
 * operator's recovery after the key leaked.
 *
 * Every string a licence or a manifest carries is printed through
 * `terminalText`, so a control character in it is shown rather than acted on.
 */
export async function runLicence(
  application: INestApplicationContext,
  args: readonly string[],
  flags: ReadonlySet<string>,
  usage: string,
): Promise<number> {
  const licences = application.get(LicenceAdminService);
  switch (args[0]) {
    case "replace-key":
      return replaceKey(
        application.get(InstanceIdentityService),
        args.slice(1).join(" "),
        flags.has("--new-id"),
      );
    case "list":
      return list(licences);
    case "add":
      return add(licences, args[1]);
    case "remove":
      return remove(licences, args[1]);
    default:
      console.error(`Unknown licence command "${args[0] ?? ""}".\n\n${usage}`);
      return 1;
  }
}

async function list(licences: LicenceAdminService): Promise<number> {
  const overview = await licences.overview();
  console.log(
    `Instance  ${overview.instance.instanceId} ${overview.instance.instanceKey}`,
  );
  console.log(
    "          (give this line to the issuer when ordering a licence)\n",
  );

  if (overview.licences.length === 0) {
    console.log("No licences are entered.");
  }
  for (const licence of overview.licences) {
    printLicence(licence);
  }

  for (const plugin of overview.plugins) {
    console.log(
      terminalText(
        `\n${plugin.pluginId}  reads "${plugin.entitlement}" from ${plugin.issuer.name}: ${describeState(plugin.state)}`,
      ),
    );
  }
  return 0;
}

async function add(
  licences: LicenceAdminService,
  path: string | undefined,
): Promise<number> {
  if (path === undefined) {
    console.error("Name the licence file: openbrf licence add <file>");
    return 1;
  }
  const file = await readFile(path);
  try {
    const licence = await licences.enter(file, {
      personId: null,
      channel: "SYSTEM",
    });
    console.log("Entered:");
    printLicence(licence);
    return 0;
  } catch (cause) {
    if (cause instanceof LicenceRefusedError) {
      console.error(`Refused: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}

async function remove(
  licences: LicenceAdminService,
  id: string | undefined,
): Promise<number> {
  if (id === undefined) {
    console.error("Name the licence to remove: openbrf licence remove <id>");
    return 1;
  }
  await licences.remove(id, { personId: null, channel: "SYSTEM" });
  console.log(terminalText(`Removed the licence ${id}.`));
  return 0;
}

async function replaceKey(
  identity: InstanceIdentityService,
  reason: string,
  newId: boolean,
): Promise<number> {
  if (reason.trim() === "") {
    console.error(
      'Give the reason, for the audit log: openbrf licence replace-key "<reason>" [--new-id]',
    );
    return 1;
  }
  const instance = await identity.replaceKey({ reason, newId });
  console.log(
    `Replaced the instance key${newId ? " and the instance id" : ""}. The old private key is deleted.`,
  );
  console.log(
    `Instance  ${instance.instanceId} ${instance.instanceKey}\n` +
      "          (give this line to the issuer to have the licences reissued)\n",
  );
  console.log(
    "Every licence entered names the old key, so none applies until it is\n" +
      "reissued. They stay entered; remove them once the new ones are in.\n" +
      "Ask the issuer to revoke the old licence ids as well: whoever holds the\n" +
      "old key can present them until it does.",
  );
  return 0;
}

function printLicence(licence: LicenceView): void {
  console.log(
    terminalText(
      `${licence.id}  [${licence.check}]  key ${licence.keyId}, entered ${licence.enteredAt}`,
    ),
  );
  console.log(`  sha256       ${licence.sha256}`);
  if (licence.licenceId !== null) {
    console.log(`  licence id   ${licence.licenceId}`);
  }
  const verified = licence.verified;
  if (verified === null) {
    return;
  }
  console.log(
    terminalText(
      `  issued to    ${verified.association.name}` +
        (verified.association.organizationNumber === null
          ? ""
          : ` (${verified.association.organizationNumber})`) +
        ` on ${verified.issuedOn}`,
    ),
  );
  console.log(
    terminalText(
      `  issuer       ${verified.issuer.name} (${verified.pluginId})`,
    ),
  );
  for (const entitlement of verified.entitlements) {
    console.log(
      terminalText(
        `  entitlement  ${entitlement.name}` +
          ` valid until ${entitlement.validUntil ?? "no end"},` +
          ` updates until ${entitlement.updatesUntil ?? "no end"}`,
      ),
    );
  }
}

function describeState(state: EntitlementState): string {
  switch (state.status) {
    case "active":
      return `active (${state.licenceId}), valid until ${state.validUntil ?? "no end"}, updates until ${state.updatesUntil ?? "no end"}`;
    case "absent":
      return "no licence is entered for it";
    case "expired":
      return `expired: the licence ${state.licenceId} was valid until ${state.validUntil}`;
    case "version-not-covered":
      return `this release (${state.released}) is newer than the licence ${state.licenceId} covers (${state.updatesUntil})`;
    case "wrong-instance":
      return `the licence ${state.licenceId} was issued to another instance`;
    case "tampered":
      return "the licence entered has been changed since it was verified";
    case "not-yet-valid":
      return `the licence ${state.licenceId} is issued on ${state.issuedOn}, after today; check the clock`;
  }
}
