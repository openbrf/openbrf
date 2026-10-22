import type { PluginLicenceDeclaration } from "@openbrf/plugin-sdk";

import type { ConsentedLicence } from "./plugin-registry.service";

/**
 * How an installed manifest's licence goes beyond what the board consented to
 * (ADR 0042), or null when it does not.
 *
 * A licence is a grant: through `present()` the plugin shows the services it
 * names that this instance holds the entitlement, which is worth the
 * association's paid use of them. So the boot gate holds it to the consent as
 * it holds the permissions:
 *
 * - another entitlement than the one consented to, or a licence where none
 *   was, is all of it unconsented, and every audience it names is listed;
 * - an audience outside the consented list is listed;
 * - fewer audiences, or no licence at all, narrows what the plugin can do and
 *   passes.
 *
 * The issuer and its keys are not compared. A key rotation arrives in a
 * release the board consents to as it does any update, and a key decides
 * which files the plugin reads, not whom it shows them to.
 */
export function licenceWidening(
  declared: PluginLicenceDeclaration | undefined,
  consented: ConsentedLicence | null,
): { audiences: string[] } | null {
  if (declared === undefined) {
    return null;
  }
  if (consented === null || consented.entitlement !== declared.entitlement) {
    return { audiences: [...declared.audiences] };
  }
  const allowed = new Set(consented.audiences);
  const added = declared.audiences.filter((audience) => !allowed.has(audience));
  return added.length === 0 ? null : { audiences: added };
}
