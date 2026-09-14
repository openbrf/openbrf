import type {
  PluginActionDeclaration,
  PluginManifest,
} from "@openbrf/plugin-sdk";
import { ACTION_NAME_PATTERN, composedActionName } from "@openbrf/plugin-sdk";

import {
  DENIED_ACTION_CAPABILITIES,
  PLUGIN_ELIGIBLE_CAPABILITIES,
} from "../actions/action-denylist";
import { CAPABILITIES } from "../authorization/capabilities";

/**
 * What a plugin's declared actions are checked for before its code runs.
 *
 * Everything answerable from the manifest alone belongs here, and the reason is
 * the loader's own rule: nothing that can refuse a plugin may run after the
 * code that executes it. A refusal found after the bundle has run has nowhere
 * good to report to and has already let the plugin construct its providers.
 *
 * What is deliberately NOT here is anything only the schema can answer - that a
 * schema was built with the host's zod, that it converts, that its document
 * refuses unknown keys at every depth. Those need the registration the bundle
 * performs, and they are checked there.
 */

/** The canonical string an action declaration is compared by. */
export function canonicalAction(action: PluginActionDeclaration): string {
  return [
    action.id,
    action.capability,
    action.effect,
    [...action.personalData].sort().join("|"),
    [...action.surfaces].sort().join("|"),
  ].join(":");
}

/**
 * Whether two declarations say the same thing, as multisets.
 *
 * Compared by canonical string rather than by deep equality, so that the order
 * a list happens to arrive in is not load-bearing and `JSON.stringify` key
 * order is not either.
 */
export function sameActionDeclaration(
  left: readonly PluginActionDeclaration[],
  right: readonly PluginActionDeclaration[],
): boolean {
  const asStrings = (actions: readonly PluginActionDeclaration[]): string[] =>
    actions.map(canonicalAction).sort();
  const a = asStrings(left);
  const b = asStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type ActionGateRefusal =
  | { reason: "actions-widened"; actions: string[] }
  | { reason: "action-refused"; actions: string[]; why: string };

/**
 * The manifest-only checks, in the order a reader would ask them.
 *
 * `installed` is the snapshot the board consented to. A declaration outside it
 * is a widening, which is the same gate the permissions and the personal-data
 * categories already have: a republished version cannot enlarge its own reach
 * by shipping an update.
 */
export function checkDeclaredActions(
  manifest: PluginManifest,
  consentedActions: readonly string[],
): ActionGateRefusal | null {
  const consented = new Set(consentedActions);
  const widened = manifest.actions
    .map((action) => canonicalAction(action))
    .filter((canonical) => !consented.has(canonical));
  if (widened.length > 0) {
    return { reason: "actions-widened", actions: widened.map(idOf) };
  }

  for (const action of manifest.actions) {
    const why = refuseDeclaration(manifest, action);
    if (why !== null) {
      return { reason: "action-refused", actions: [action.id], why };
    }
  }

  return null;
}

function idOf(canonical: string): string {
  return canonical.split(":")[0] ?? canonical;
}

function refuseDeclaration(
  manifest: PluginManifest,
  action: PluginActionDeclaration,
): string | null {
  const composed = composedActionName(manifest.id, action.id);
  if (!ACTION_NAME_PATTERN.test(composed)) {
    return `the public name "${composed}" is not a usable action name`;
  }

  if (!(CAPABILITIES as readonly string[]).includes(action.capability)) {
    return `"${action.capability}" is not a capability this instance has`;
  }

  if (
    (DENIED_ACTION_CAPABILITIES as readonly string[]).includes(
      action.capability,
    )
  ) {
    // The ways authority moves, and the way protected personal data is
    // revealed. No action of any kind may hold one, core actions included.
    return `"${action.capability}" is a capability no action may hold`;
  }

  if (
    !(PLUGIN_ELIGIBLE_CAPABILITIES as readonly string[]).includes(
      action.capability,
    )
  ) {
    return `"${action.capability}" is not a capability a plugin's action may ask for`;
  }

  if (
    action.personalData.includes("protected") &&
    action.surfaces.some((surface) => surface === "mcp" || surface === "ai")
  ) {
    /*
     * An action that can return a field of a person carrying protected
     * personal data (skyddade personuppgifter) is offered in process and
     * nowhere else. Beslutslogg 64 puts that data outside every token and
     * every prompt, and the declaration is what the board reads on the consent
     * screen - so the refusal belongs where the board can still act on it.
     */
    return "an action touching protected personal data may not be offered to connected apps or to the AI package";
  }

  /*
   * Not checked here, though it is tempting: that a delete declares
   * needsConfirmation. That flag lives on the definition the bundle registers
   * rather than in the manifest, so the manifest cannot answer for it and the
   * registry refuses it at registration instead.
   */
  return null;
}
