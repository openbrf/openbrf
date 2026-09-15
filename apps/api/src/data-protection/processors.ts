import type {
  ProcessorAgreementStatus,
  ProcessorClassification,
  ProcessorKind,
} from "../generated/prisma/enums";
import { selectedDriverKind } from "../sms/sms.service";
import {
  connectedAppProcessorKey,
  pluginProcessorKey,
  type FixedProcessorKey,
} from "./processor-key";

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
  /**
   * The clients members have connected and allowed to act for them.
   *
   * Registered *and* consented to, both halves. A client row exists as soon as
   * an app presents its metadata document, and a registration on its own hands
   * nobody anything: what makes a client a recipient is a person having allowed
   * it to act, which is the consent row. A client with no consent behind it is
   * not listed, for the reason the SMS gateway is not listed on an instance
   * that has none.
   */
  connectedApps: readonly {
    /** The client row's id, which its recipient key is built from. */
    id: string;
    /** As the client declared itself, or null where it declared no name. */
    name: string | null;
    /** Where it is reached: see {@link connectedAppHost}. */
    host: string | null;
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

/**
 * The host a connected app is reached at: the client-id URL it presented, or
 * failing that the client URI it registered.
 *
 * Null rather than the value as written, which is where this differs from
 * {@link hostOf} below. A gateway address is configured by an administrator and
 * is what the instance posts to whatever it says; a client id is chosen by the
 * app itself, and one that will not parse is not a host - so the record and the
 * report name nothing rather than something untrue.
 *
 * One definition because the record of processing, the art. 28 list and the
 * access report all have to call the same client the same thing.
 */
export function connectedAppHost(client: {
  clientDiscoveryId: string | null;
  uri: string | null;
}): string | null {
  const url = client.clientDiscoveryId ?? client.uri;
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
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

  /*
   * One recipient per app a member has connected.
   *
   * The classification is suggested rather than asked for, which is what makes
   * these rows different from the plugins above. A connected app is the
   * person's own tool, chosen by them and acting on their instruction, so it
   * decides its own purposes - `INDEPENDENT_CONTROLLER`, which the schema
   * defines as a controller in its own right that art. 28 does not apply to.
   * The association engaged nobody, so there is no agreement for it to seek,
   * and a row asking the board to produce one would describe a contract that
   * cannot exist.
   *
   * Listed all the same, because a recipient that exists is always listed. Data
   * leaves the instance to these clients, and a record of recipients that
   * skipped the ones nobody has to sign an agreement with would be answering a
   * narrower question than art. 30(1)(d) asks.
   */
  for (const app of facts.connectedApps) {
    const key = connectedAppProcessorKey(app.id);
    descriptors.push({
      processorKey: key,
      processorKind: "EXTERNAL",
      // The name where the app declared one, and the host where it did not:
      // both are what a board reads to recognise which app this is.
      identity: app.name ?? app.host,
      detail: app.name === null ? null : app.host,
      seededClassification: "INDEPENDENT_CONTROLLER",
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
