import type { PluginLicenceDeclaration } from "@openbrf/plugin-sdk";

import { declaredKeyFingerprint } from "../licences/entitlement-judgement";
import type { ConsentedLicence } from "./plugin-registry.service";

/** Why the boot gate refuses an installed manifest's licence. */
export interface LicenceRefusal {
  reason: "licence-widened" | "licence-issuer-changed";
  /**
   * The audiences and the key ids beyond the consent. Every one the manifest
   * names where nothing of it was consented to.
   */
  detail: { audiences: string[]; keys: string[] };
}

/**
 * How an installed manifest's licence goes beyond what the board consented to
 * (ADR 0042), or null when it does not.
 *
 * A licence is a grant: through `present()` the plugin shows the services it
 * names that this instance holds the entitlement, which is worth the
 * association's paid use of them. And its keys decide whose licences it
 * reads: a licence one of them verified is the plugin's, whoever signed it.
 * So the boot gate holds it to the consent as it holds the permissions.
 *
 * `licence-widened`, which the board's consent to the new declaration
 * settles, as it does the update that brings a rotation's new key:
 *
 * - another entitlement than the one consented to, or a licence where none
 *   was, is all of it unconsented, and every audience and key it names is
 *   listed;
 * - an audience outside the consented list is listed;
 * - a key outside the consented ones, beside every consented key, is listed.
 *
 * `licence-issuer-changed`, for a manifest that is not the issuer's of the
 * catalog entry installed: it names another issuer, or no longer declares a
 * consented key, whether it dropped the key or put another in its place. The
 * catalog repeats the manifest's declaration, and a release that drops a key
 * reaches this instance as an update the board consents to, which records the
 * keys it keeps. So an installed package that disagrees with the consent is
 * not the package of the catalog entry installed, and is not loaded on the
 * half that agrees.
 * The audiences and keys it declares outside the consent are listed.
 *
 * Fewer audiences, or no licence at all, narrows what the plugin can do and
 * passes.
 */
export function licenceRefusal(
  declared: PluginLicenceDeclaration | undefined,
  consented: ConsentedLicence | null,
): LicenceRefusal | null {
  if (declared === undefined) {
    return null;
  }
  const keys = Object.entries(declared.keys).map(([keyId, encoded]) => ({
    keyId,
    fingerprint: declaredKeyFingerprint(encoded),
  }));
  if (consented === null || consented.entitlement !== declared.entitlement) {
    return {
      reason: "licence-widened",
      detail: {
        audiences: [...declared.audiences],
        keys: keys.map((key) => key.keyId),
      },
    };
  }

  const allowed = new Set(consented.audiences);
  const consentedKeys = new Set(consented.keys);
  const detail = {
    audiences: declared.audiences.filter((audience) => !allowed.has(audience)),
    keys: keys
      .filter((key) => !consentedKeys.has(key.fingerprint))
      .map((key) => key.keyId),
  };

  const declaredKeys = new Set(keys.map((key) => key.fingerprint));
  if (
    declared.issuer.name !== consented.issuer.name ||
    declared.issuer.url !== consented.issuer.url ||
    consented.keys.some((fingerprint) => !declaredKeys.has(fingerprint))
  ) {
    return { reason: "licence-issuer-changed", detail };
  }
  return detail.audiences.length === 0 && detail.keys.length === 0
    ? null
    : { reason: "licence-widened", detail };
}

/**
 * Whether a refusal is over the manifest's issuer or keys, so that its keys
 * must verify no licence and the package keeps no manifest.
 *
 * A refusal over audiences alone leaves the keys as consented: the boot keeps
 * the manifest dormant, and a licence signed with one of those keys is the
 * plugin's. A manifest with no consent to a licence at all has none of its keys
 * consented to, whatever the refusal lists.
 */
export function keysRefused(
  refusal: LicenceRefusal,
  consented: ConsentedLicence | null,
): boolean {
  return (
    refusal.reason === "licence-issuer-changed" ||
    refusal.detail.keys.length > 0 ||
    consented === null
  );
}
