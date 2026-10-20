import {
  extensionGroupRefusals,
  extensionHostPersonalDataRefused,
  extensionPermissionsRefused,
  type PluginExtensionDeclaration,
  type PluginExtensionPointDeclaration,
  type PluginFindingDetail,
  type PluginManifest,
} from "@openbrf/plugin-sdk";

/**
 * What a plugin's extension declarations are checked for before its code runs
 * (ADR 0030).
 *
 * Everything here reads manifests alone, for the loader's own rule: nothing
 * that can refuse a plugin may run after the code that executes it. Whether an
 * addon's targets exist, at the version it was written for, and accept what it
 * hands over is a question about two manifests, so an addon that fails it is
 * refused before its bundle is required. What only a bundle can answer - that
 * its schemas are strict and built with the host's zod - is checked when the
 * definitions are flushed (plugin-host.binder.ts).
 */

/** The canonical string an extension point is compared by. */
export function canonicalExtensionPoint(
  point: PluginExtensionPointDeclaration,
): string {
  return [
    point.id,
    String(point.version),
    [...point.personalData].sort().join("|"),
  ].join(":");
}

/** The canonical string an extension is compared by. */
export function canonicalExtension(
  extension: PluginExtensionDeclaration,
): string {
  return [
    extension.plugin,
    extension.point,
    String(extension.version),
    [...extension.personalData].sort().join("|"),
  ].join(":");
}

/** How a widened extension is named on the board's screen. */
function extensionName(extension: PluginExtensionDeclaration): string {
  return `${extension.plugin}/${extension.point}`;
}

/** Whether two lists say the same thing, as multisets of canonical strings. */
export function sameCanonicalDeclaration(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The points and extensions the installed manifest declares beyond what the
 * board consented to, or null when it declares nothing more.
 *
 * The same gate `permissions-widened` and `actions-widened` are, compared by
 * the whole declaration: a republished host plugin that adds a point or lets
 * one accept more, and a republished addon that extends a new point or hands
 * over more, both need the board's consent again.
 */
export function widenedExtensions(
  manifest: PluginManifest,
  consented: {
    extensionPoints: readonly string[];
    extends: readonly string[];
  },
): PluginFindingDetail | null {
  const points = new Set(consented.extensionPoints);
  const extensions = new Set(consented.extends);
  const widened = [
    ...manifest.extensionPoints
      .filter((point) => !points.has(canonicalExtensionPoint(point)))
      .map((point) => point.id),
    ...manifest.extends
      .filter((extension) => !extensions.has(canonicalExtension(extension)))
      .map(extensionName),
  ];
  return widened.length === 0 ? null : { extensions: widened };
}

export interface ExtensionTargetRefusal {
  reason:
    | "extension-host-missing"
    | "extension-point-unknown"
    | "extension-version-unsupported"
    | "extension-personal-data-refused"
    | "extension-permission-refused"
    | "extension-host-personal-data-refused";
  detail: PluginFindingDetail;
}

/**
 * Why an addon cannot serve at the points it extends, or null when it can.
 *
 * `hosts` holds the manifests of the plugins that will be loaded beside it. A
 * plugin it extends that is not among them - not installed, refused, or
 * switched off - is `extension-host-missing`: an addon exists for its host, and
 * while the host does not serve, neither does the addon.
 *
 * The first refusal in the order the manifest lists its extensions, and in the
 * order a reader would ask: is the plugin there, does it have the point, at
 * this version, does the point accept what the addon hands over, may either
 * of the two be handed anything the other can read, and may a website addon be
 * handed personal data at all.
 */
export function refuseExtensionTargets(
  manifest: PluginManifest,
  hosts: ReadonlyMap<string, PluginManifest>,
): ExtensionTargetRefusal | null {
  for (const extension of manifest.extends) {
    const host = hosts.get(extension.plugin);
    if (host === undefined) {
      return {
        reason: "extension-host-missing",
        detail: { plugin: extension.plugin },
      };
    }
    const point = host.extensionPoints.find(
      (declared) => declared.id === extension.point,
    );
    if (point === undefined) {
      return {
        reason: "extension-point-unknown",
        detail: { plugin: extension.plugin, point: extension.point },
      };
    }
    if (point.version !== extension.version) {
      return {
        reason: "extension-version-unsupported",
        detail: {
          plugin: extension.plugin,
          point: extension.point,
          version: extension.version,
          supported: point.version,
        },
      };
    }
    const accepted = new Set(point.personalData);
    const refused = extension.personalData.filter(
      (category) => !accepted.has(category),
    );
    if (refused.length > 0) {
      return {
        reason: "extension-personal-data-refused",
        detail: {
          plugin: extension.plugin,
          point: extension.point,
          categories: refused,
        },
      };
    }
    // Read from the permissions, not the declaration above: a website's
    // point accepts no personal data, and an addon that reads the register
    // could say it hands over none and still return a name. The other way
    // round, a website addon could be handed names as the point's input.
    const permissions = extensionPermissionsRefused(manifest, host);
    if (permissions.length > 0) {
      return {
        reason: "extension-permission-refused",
        detail: {
          plugin: extension.plugin,
          point: extension.point,
          permissions,
        },
      };
    }
    const categories = extensionHostPersonalDataRefused(manifest, host);
    if (categories.length > 0) {
      return {
        reason: "extension-host-personal-data-refused",
        detail: {
          plugin: extension.plugin,
          point: extension.point,
          categories,
        },
      };
    }
  }
  return null;
}

/**
 * The addons refused with `extension-group-refused` because of the plugins
 * joined to them by extensions (ADR 0030), by id, with the detail the board
 * is shown.
 *
 * `hosts` are the plugins that loaded extending nothing, and `addons` the
 * addons that passed `refuseExtensionTargets` against them. The answer reads
 * the whole set before any addon's code runs, and not the order the packages
 * were found in, so the same addons are refused on every boot.
 */
export function refuseExtensionGroups(
  hosts: Iterable<PluginManifest>,
  addons: readonly PluginManifest[],
): Map<string, PluginFindingDetail> {
  const refusals = new Map<string, PluginFindingDetail>();
  for (const [id, refusal] of extensionGroupRefusals([...hosts, ...addons])) {
    refusals.set(id, { website: refusal.website, register: refusal.register });
  }
  return refusals;
}
