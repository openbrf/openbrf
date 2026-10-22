import type {
  EntitlementState,
  PluginLicenceDeclaration,
} from "@openbrf/plugin-sdk";

import {
  ed25519PublicKey,
  keyFingerprint,
  type LicencePayload,
  verifiedPayload,
} from "./licence-file";

/**
 * How the host judges one plugin's entitlement from the licences entered
 * (ADR 0042), as a function of what it is given: no database, no clock and no
 * network, so every rule below is tested by itself.
 */

/** A licence as the store holds it. */
export interface StoredLicence {
  id: string;
  file: Uint8Array;
  enteredAt: Date;
  /** The fingerprint of the key that verified it, or null: not yet checked. */
  verifiedKeyFingerprint: string | null;
  /** The entitlements its payload named when that key verified it. */
  entitlements: readonly string[];
}

/** What a licensed plugin's manifest says about the licence it reads. */
export interface LicenceReader {
  licence: PluginLicenceDeclaration;
  released: string;
}

/** The instance a licence has to be bound to. */
export interface InstanceBinding {
  instanceId: string;
  /** base64url of the 32-byte public key. */
  instanceKey: string;
}

export interface EntitlementJudgement {
  state: EntitlementState;
  /** The licence `present()` presents: the one judged active, or null. */
  selected: { licence: StoredLicence; payload: LicencePayload } | null;
}

/** A declared key, by fingerprint. */
export interface DeclaredKey {
  keyId: string;
  fingerprint: string;
  key: ReturnType<typeof ed25519PublicKey>;
}

/** The keys a manifest declares, decoded once. */
export function declaredKeys(licence: PluginLicenceDeclaration): DeclaredKey[] {
  return Object.entries(licence.keys).map(([keyId, encoded]) => {
    const raw = Buffer.from(encoded, "base64");
    return {
      keyId,
      fingerprint: keyFingerprint(raw),
      key: ed25519PublicKey(raw),
    };
  });
}

/**
 * The fingerprint of a key as a manifest writes it, the padded base64 of its
 * 32 bytes: the one a licence it verified is judged by.
 */
export function declaredKeyFingerprint(encoded: string): string {
  return keyFingerprint(Buffer.from(encoded, "base64"));
}

type Finding =
  | { kind: "tampered"; licence: StoredLicence }
  | {
      kind: "read";
      licence: StoredLicence;
      payload: LicencePayload;
      state: EntitlementState;
    };

/**
 * The finding for a plugin's entitlement today.
 *
 * Only licences one of the plugin's own keys verified are read, judged by
 * fingerprint: a licence another plugin's key verified never shows here, even
 * under the same key id, and neither does one not yet checked. Among the
 * active ones a single order selects, so `get()` and `present()` never
 * describe two different licences and the order the files were entered in
 * changes nothing. With none active, the finding is that of the licence
 * entered most recently.
 */
export function judgeEntitlement(input: {
  licences: readonly StoredLicence[];
  reader: LicenceReader;
  instance: InstanceBinding;
  /** The association's calendar day, `YYYY-MM-DD`. */
  today: string;
}): EntitlementJudgement {
  const { reader, instance, today } = input;
  const entitlement = reader.licence.entitlement;
  const keys = new Map(
    declaredKeys(reader.licence).map((declared) => [
      declared.fingerprint,
      declared.key,
    ]),
  );

  const findings: Finding[] = [];
  for (const licence of input.licences) {
    const key =
      licence.verifiedKeyFingerprint === null
        ? undefined
        : keys.get(licence.verifiedKeyFingerprint);
    if (key === undefined) {
      continue;
    }
    const payload = verifiedPayload(licence.file, key);
    if (payload === null) {
      // Checked under one of this plugin's keys when it was entered, and no
      // longer verifying: the row was changed since. Reported to the plugin
      // whose entitlement it named then, and to no other.
      if (licence.entitlements.includes(entitlement)) {
        findings.push({ kind: "tampered", licence });
      }
      continue;
    }
    // Own keys only: the payload is an ordinary object, so indexing it with an
    // entitlement named `constructor` would read Object's own constructor as a
    // grant without dates, which the issuer never signed.
    if (!Object.hasOwn(payload.entitlements, entitlement)) {
      continue;
    }
    const granted = payload.entitlements[entitlement];
    if (granted === undefined) {
      continue;
    }
    findings.push({
      kind: "read",
      licence,
      payload,
      state: stateOf(payload, granted, reader.released, instance, today),
    });
  }

  const active = findings
    .filter(
      (finding): finding is Extract<Finding, { kind: "read" }> =>
        finding.kind === "read" && finding.state.status === "active",
    )
    .sort((left, right) =>
      compareActive(left.payload, right.payload, entitlement),
    );
  const chosen = active[0];
  if (chosen !== undefined) {
    return {
      state: chosen.state,
      selected: { licence: chosen.licence, payload: chosen.payload },
    };
  }

  const latest = [...findings].sort(
    (left, right) =>
      right.licence.enteredAt.getTime() - left.licence.enteredAt.getTime() ||
      compareText(left.licence.id, right.licence.id),
  )[0];
  if (latest === undefined) {
    return { state: { status: "absent" }, selected: null };
  }
  return {
    state: latest.kind === "tampered" ? { status: "tampered" } : latest.state,
    selected: null,
  };
}

/**
 * One licence's finding for one entitlement. Dates are `YYYY-MM-DD`, which
 * compare as text in the order of the days they name.
 */
function stateOf(
  payload: LicencePayload,
  granted: {
    validUntil?: string | undefined;
    updatesUntil?: string | undefined;
  },
  released: string,
  instance: InstanceBinding,
  today: string,
): EntitlementState {
  const licenceId = payload.licenceId;
  if (
    payload.instanceId !== instance.instanceId ||
    payload.instanceKey !== instance.instanceKey
  ) {
    return { status: "wrong-instance", licenceId };
  }
  if (payload.issuedOn > today) {
    return { status: "not-yet-valid", licenceId, issuedOn: payload.issuedOn };
  }
  if (granted.validUntil !== undefined && today > granted.validUntil) {
    return { status: "expired", licenceId, validUntil: granted.validUntil };
  }
  if (granted.updatesUntil !== undefined && released > granted.updatesUntil) {
    return {
      status: "version-not-covered",
      licenceId,
      updatesUntil: granted.updatesUntil,
      released,
    };
  }
  return {
    status: "active",
    licenceId,
    validUntil: granted.validUntil ?? null,
    updatesUntil: granted.updatesUntil ?? null,
  };
}

/**
 * The selection among active licences: the latest `validUntil`, then the
 * latest `updatesUntil` (an absent date counts as the latest of all), then the
 * latest `issuedOn`, then the lowest licence id.
 */
function compareActive(
  left: LicencePayload,
  right: LicencePayload,
  entitlement: string,
): number {
  const leftGrant = left.entitlements[entitlement];
  const rightGrant = right.entitlements[entitlement];
  return (
    compareOpenEnded(rightGrant?.validUntil, leftGrant?.validUntil) ||
    compareOpenEnded(rightGrant?.updatesUntil, leftGrant?.updatesUntil) ||
    compareText(right.issuedOn, left.issuedOn) ||
    compareText(left.licenceId, right.licenceId)
  );
}

/** Orders dates with an absent one after every present one. */
function compareOpenEnded(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return compareText(left, right);
}

/** Code-unit order, which does not depend on the process's locale. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
