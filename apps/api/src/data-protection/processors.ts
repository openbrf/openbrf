import type {
  ProcessorAgreementStatus,
  ProcessorClassification,
  ProcessorKind,
} from "../generated/prisma/enums";
import { selectedDriverKind } from "../sms/sms.service";
import { pluginProcessorKey, type FixedProcessorKey } from "./processor-key";

/**
 * Who this instance actually hands personal data to, read from what it is
 * configured to do.
 *
 * The record of recipients cannot be a list the board types in, because a board
 * cannot be expected to know that changing the storage driver introduced a new
 * one. So the list is derived from the instance's own settings and the plugins
 * installed on it, and what the board contributes is the judgement: whether
 * each recipient is a processor (GDPR art. 4(8)), and what agreement covers it.
 *
 * The derivation is deliberately conservative in one direction and honest in
 * the other. A recipient that exists is always listed, even when the board has
 * said nothing about it - that is the "notRecorded" state, which is a question
 * the screen asks rather than a gap it hides. But a recipient that does not
 * exist is never listed: an instance with no SMS provider configured hands
 * nobody anything by SMS, and a row asking the board to classify a gateway it
 * does not use would be a false entry in a statutory record.
 *
 * Storage and hosting are always listed, and for opposite reasons. Storage
 * always exists, but under the local driver it is the association's own disk,
 * which is no processor at all - so it is listed with that classification
 * already suggested, and the board confirms rather than researches. Hosting
 * always exists and the instance cannot see it: somebody runs the machine, and
 * whether they are a processor depends on who they are. That row exists to be
 * answered by the only party who knows.
 */

/** What the settings row, the environment and installed_plugin already hold. */
export interface ProcessorFacts {
  smtpHost: string | null;
  smtpFromAddress: string | null;
  smsDriver: string | null;
  smsGatewayUrl: string | null;
  storageDriver: "local" | "s3";
  s3Endpoint: string | null;
  s3Region: string | null;
  s3Bucket: string | null;
  installedPlugins: readonly {
    id: string;
    packageName: string;
    version: string;
  }[];
}

/** An open agreement row, as much of it as the state derivation needs. */
export interface OpenAgreementRow {
  processorKey: string;
  classification: ProcessorClassification;
  status: ProcessorAgreementStatus | null;
  /** Who the other party is. The only name a board-recorded recipient has. */
  counterparty: string | null;
}

/**
 * What the board has said about a recipient, or that it has not been asked yet.
 *
 * "notRecorded" is the absence of an open row and is never stored: a stored
 * "unrecorded" status would be a claim, and this is the lack of one.
 */
export type ProcessorAgreementState =
  | "inPlace"
  | "pending"
  | "notAProcessor"
  | "independentController"
  | "notRecorded";

export interface ProcessorDescriptor {
  processorKey: string;
  processorKind: ProcessorKind;
  /**
   * How the recipient is named on screen: a host, a bucket, a package.
   *
   * Null where the instance has no name to give. Storage on the association's
   * own disk and whoever runs the machine are recipients that exist without
   * being called anything - there is no host to read and no package to name -
   * and a placeholder written here would reach a Swedish board as an English
   * word beside a translated one. The screen says what kind it is instead,
   * which is the whole of what the instance knows.
   */
  identity: string | null;
  /** A second line where there is one, e.g. the region a bucket is signed for. */
  detail: string | null;
  /**
   * The classification the facts already imply, where they imply one. Only the
   * local disk has one: the association's own storage is no processor, and
   * asking the board to work that out would be asking it to research its own
   * hard drive.
   */
  seededClassification: ProcessorClassification | null;
  state: ProcessorAgreementState;
}

/**
 * What a recipient's row says about it, as the screens read it.
 *
 * Exported because the plugin screen asks the same question of the same rows:
 * a second spelling of this mapping would let the two screens disagree about
 * one recipient, and a new agreement status would have to be added twice.
 */
export function stateOf(
  row: OpenAgreementRow | undefined,
): ProcessorAgreementState {
  if (row === undefined) {
    return "notRecorded";
  }
  if (row.classification === "NOT_A_PROCESSOR") {
    return "notAProcessor";
  }
  if (row.classification === "INDEPENDENT_CONTROLLER") {
    return "independentController";
  }
  return row.status === "IN_PLACE" ? "inPlace" : "pending";
}

/** The host part of a URL, for naming a gateway without repeating its path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A gateway address that will not parse is still what the instance is
    // configured to post to, so it is named as written rather than dropped:
    // a recipient omitted from the record is worse than one named awkwardly.
    return url;
  }
}

/**
 * The recipients this instance currently has, each joined with what the board
 * has said about it.
 *
 * @param facts What the instance is configured to do.
 * @param openRows Every open agreement row, in any order.
 */
export function currentProcessors(
  facts: ProcessorFacts,
  openRows: readonly OpenAgreementRow[],
): ProcessorDescriptor[] {
  const byKey = new Map(openRows.map((row) => [row.processorKey, row]));
  const descriptors: ProcessorDescriptor[] = [];

  const fixed = (
    key: FixedProcessorKey,
    processorKind: ProcessorKind,
    identity: string | null,
    detail: string | null = null,
    seededClassification: ProcessorClassification | null = null,
  ): void => {
    descriptors.push({
      processorKey: key,
      processorKind,
      identity,
      detail,
      seededClassification,
      state: stateOf(byKey.get(key)),
    });
  };

  // Mail. Both halves, because the settings screen reports an instance that
  // cannot send as exactly that, and a host with no sender address sends
  // nothing.
  if (facts.smtpHost !== null && facts.smtpFromAddress !== null) {
    fixed("smtp", "SMTP", facts.smtpHost, facts.smtpFromAddress);
  }

  // SMS only where a provider is actually configured. An instance with none
  // publishes its news all the same and says on screen that the SMS mailing is
  // what did not go out; it hands nobody anything, so it has no recipient here.
  if (
    selectedDriverKind({
      driver: facts.smsDriver,
      gatewayUrl: facts.smsGatewayUrl,
    }) !== "none"
  ) {
    fixed("sms", "SMS", hostOf(facts.smsGatewayUrl ?? ""));
  }

  if (facts.storageDriver === "s3") {
    fixed(
      "storage",
      "STORAGE",
      [facts.s3Endpoint, facts.s3Bucket]
        .filter((part) => part !== null)
        .join(" / "),
      facts.s3Region,
    );
  } else {
    fixed("storage", "STORAGE", null, null, "NOT_A_PROCESSOR");
  }

  fixed("hosting", "HOSTING", null);

  for (const plugin of facts.installedPlugins) {
    const key = pluginProcessorKey(plugin.id);
    descriptors.push({
      processorKey: key,
      processorKind: "PLUGIN",
      identity: plugin.packageName,
      detail: plugin.version,
      seededClassification: null,
      state: stateOf(byKey.get(key)),
    });
  }

  // A recipient the board recorded itself exists because its row does: there is
  // no fact about the instance to derive it from, which is why it is the one
  // kind whose descriptor is built from the agreement rather than joined to it.
  for (const row of openRows) {
    if (!row.processorKey.startsWith("external:")) {
      continue;
    }
    descriptors.push({
      processorKey: row.processorKey,
      processorKind: "EXTERNAL",
      identity: row.counterparty ?? row.processorKey.slice("external:".length),
      detail: null,
      seededClassification: null,
      state: stateOf(row),
    });
  }

  return descriptors;
}
