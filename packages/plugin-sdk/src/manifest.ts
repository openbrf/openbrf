import { z } from "zod";

import {
  ACTION_EFFECTS,
  ACTION_NAME_PATTERN,
  ACTION_PERSONAL_DATA,
  ACTION_SURFACES,
} from "./actions.ts";
import { PLUGIN_API_VERSION } from "./api-version.ts";
import { pluginBlocksSchema } from "./blocks.ts";
import {
  EXTENSION_POINT_ID_PATTERN,
  MAX_EXTENSION_POINTS,
} from "./extensions.ts";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
} from "./permissions.ts";
import { pluginSettingsSchema } from "./settings-schema.ts";

/**
 * The plugin manifest.
 *
 * It lives in the `openbrf` field of the plugin's own package.json rather
 * than in a separate file: npm already installs package.json, already
 * validates its name and version, and already refuses to install a package
 * without one. A second manifest file could go missing, disagree with the
 * package it sits in, or be left behind by a partial extraction, and the
 * loader would have to decide which of the two to believe.
 */

/**
 * A plugin id.
 *
 * Used as a URL segment (`/api/plugin/<id>/...`), an i18n namespace
 * (`plugin-<id>`), a database key and a directory name, so it is restricted to
 * what is safe in all four. In particular it may not contain a dot or a
 * slash: a plugin id is resolved against paths, and `..` must not be
 * expressible.
 */
export const pluginIdSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
    "must be lowercase letters, digits and single hyphens, starting with a letter",
  );

/**
 * A path inside the plugin package.
 *
 * Relative and normalized by the schema's own rules rather than by the
 * loader: an entry point is read from a manifest that arrived over the
 * network, so "../../../etc/passwd" has to be rejected where the shape is
 * defined and not at each of the places that later join it onto a directory.
 */
const packageRelativePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine(
    (value) => !value.split("/").includes(".."),
    "must not step outside the package",
  )
  .refine((value) => !value.includes("\0"), "must not contain a null byte");

export const pluginEntrySchema = z
  .object({
    /**
     * Prebuilt CJS bundle whose only externals are host packages and Node's
     * built-in modules (ADR 0003).
     * Optional: a plugin may contribute a view and no backend behaviour.
     */
    server: packageRelativePathSchema.optional(),
    /**
     * Module Federation remote entry, served to the browser and loaded at
     * runtime. Optional: a plugin may contribute a background job and no view.
     */
    client: packageRelativePathSchema.optional(),
  })
  .refine(
    (entry) => entry.server !== undefined || entry.client !== undefined,
    "a plugin must declare at least one entry point",
  );

/**
 * A route under the plugin's own mount at `/api/plugin/<id>/`.
 *
 * Written without a leading slash and joined onto that mount by the host, for
 * the reason the package-relative schema exists: the value arrives in a
 * manifest fetched over the network, and it decides a URL an unauthenticated
 * caller will be pointed at, so what it may contain is settled here rather
 * than at each place that joins it.
 */
const pluginRoutePathSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/,
    "must be lowercase path segments separated by single slashes, with no leading or trailing slash",
  );

/**
 * One action the plugin proposes.
 *
 * Declared in the manifest rather than at registration, because the board reads
 * it on the install consent screen before anything has been downloaded, and
 * nothing that can refuse a plugin may run after the code that executes it. The
 * plugin's bundle supplies the schemas and the handler; what it may ask for is
 * settled here.
 *
 * `capability` is a free string because this package cannot import the core
 * capability union - it is published to plugin authors and the union is the
 * instance's. It is resolved against the real list at the boot gate, which also
 * refuses the ones no action of any kind may hold.
 */
export const pluginActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  capability: z.string().min(1).max(64),
  effect: z.enum(ACTION_EFFECTS),
  personalData: z.array(z.enum(ACTION_PERSONAL_DATA)).max(14).default([]),
  surfaces: z.array(z.enum(ACTION_SURFACES)).max(3).default(["ui"]),
});

/**
 * The declared actions, as every boundary that reads them must read them.
 *
 * One schema rather than the same array written twice, because the invariant
 * below has to hold at both: the catalog entry the consent screen renders from,
 * and the manifest the loader enforces against it.
 *
 * An id appears once. Two declarations sharing one id are not a redundancy that
 * sorts itself out - each of the three places that reads them resolves the
 * collision differently. The binder takes the LAST, through a Map; consent
 * compares canonical strings as a SET, so reordering the pair leaves the
 * comparison equal and asks the board nothing; and arming stores the bare id,
 * which names both. A republished version that only swapped the order of a
 * duplicated pair would therefore keep its arming and go live at the OTHER
 * declaration's capability, personal data and surfaces, with nobody having
 * decided that. An action is one operation with one capability; two of them
 * wearing one id is not a declaration this can read.
 *
 * Undefaulted, so each use site says for itself whether an absent list means
 * "none declared" or "you did not answer". A manifest and a catalog entry mean
 * the first and add `.default([])`; the install request means the second, since
 * a board's echo that silently became an empty list would read as consent to no
 * action at all - and a plugin that declares one would then be refused with a
 * mismatch nothing the board could do would satisfy.
 */
export const pluginActionsSchema = declaredActionsSchema(pluginActionSchema);

/**
 * The declared actions over a given reading of one action.
 *
 * The manifest reads an action as `pluginActionSchema` does; the catalog index
 * reads the same fields strictly, because the index refuses a field its
 * version does not define. Both keep the rule above, which is why the list is
 * built here rather than written again.
 */
export function declaredActionsSchema<T extends z.ZodType<{ id: string }>>(
  action: T,
) {
  return z
    .array(action)
    .max(16)
    .superRefine((actions, ctx) => {
      const seen = new Set<string>();
      for (const [index, declared] of actions.entries()) {
        if (seen.has(declared.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `two actions are declared with the id "${declared.id}"`,
          });
        }
        seen.add(declared.id);
      }
    });
}

/**
 * The public name a declared action is offered under.
 *
 * The plugin's id with dashes folded to underscores, then the action's id. The
 * folding has a consequence worth knowing: a plugin `a-b` declaring `c` and a
 * plugin `a` declaring `b_c` compose the same name, so the registry refuses the
 * second one to arrive and docs/plugin-contract.md says so.
 */
export function composedActionName(pluginId: string, actionId: string): string {
  return `${pluginId.replaceAll("-", "_")}_${actionId}`;
}

/**
 * The sections of the application's navigation a plugin's view may stand in.
 *
 * The application's own four, in the order its band shows them: the
 * association and its life, the building and the apartments in it, the board's
 * own desk, and the settings. A plugin names one of them rather than a section
 * of its own, so a view is found where a destination of its kind already is.
 */
export const PLUGIN_VIEW_SECTIONS = [
  "association",
  "building",
  "board",
  "settings",
] as const;

export type PluginViewSection = (typeof PLUGIN_VIEW_SECTIONS)[number];

export const pluginViewSchema = z.object({
  /** Named export of the remote module, per Module Federation. */
  module: z.string().min(1).max(100).default("./View"),
  titleKey: z.string().min(1).max(200),
  /**
   * The section of the navigation the view is offered in, under its title.
   *
   * Optional, and a view without one is reachable by its address alone, as
   * every view was before the field existed. Naming a section asks for an
   * entry rather than granting one: the host offers it only to an account that
   * holds what the plugin's routes require, and in the board's section only to
   * the board, because that section holds nothing a resident is offered.
   */
  section: z.enum(PLUGIN_VIEW_SECTIONS).optional(),
});

/** The id of an extension point, unique within the plugin that declares it. */
export const extensionPointIdSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(
    EXTENSION_POINT_ID_PATTERN,
    "must be lowercase letters, digits and single hyphens, starting with a letter",
  );

/**
 * One extension point the plugin offers other plugins (ADR 0030).
 *
 * Declared here rather than at registration for the reason an action is: the
 * board reads what the point accepts on the consent screen before anything is
 * downloaded. The bundle supplies the schemas; what may cross is settled here.
 */
export const pluginExtensionPointSchema = z.object({
  id: extensionPointIdSchema,
  /**
   * The point's major version, raised when a change to its schemas would break
   * an addon written for the last one.
   */
  version: z.int().min(1),
  /**
   * The categories of personal data a contribution may hand the plugin
   * through this point. Among the plugin's own `personalData`, because what an
   * addon hands it is handled by it as much as what it reads itself.
   */
  personalData: z
    .array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES))
    .max(16)
    .default([]),
});

/** One extension point of another plugin that this plugin extends. */
export const pluginExtensionSchema = z.object({
  /** The id of the host plugin. */
  plugin: pluginIdSchema,
  /** The id of the extension point. */
  point: extensionPointIdSchema,
  /** The point's major version the addon was written against. */
  version: z.int().min(1),
  /**
   * The categories the contribution hands the host plugin. Among the addon's
   * own `personalData`, and among what the point accepts, which the host
   * checks against the host plugin's manifest when both are loaded.
   */
  personalData: z
    .array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES))
    .max(16)
    .default([]),
});

/**
 * The declared extension points over a given reading of one point.
 *
 * The manifest reads a point as `pluginExtensionPointSchema` does; the catalog
 * index reads it strictly and with the curator's title and description. Both
 * keep the rule that an id appears once, which is why the list is built here.
 */
export function declaredExtensionPointsSchema<
  T extends z.ZodType<{ id: string }>,
>(point: T) {
  return z
    .array(point)
    .max(MAX_EXTENSION_POINTS)
    .superRefine((points, ctx) => {
      const seen = new Set<string>();
      for (const [index, declared] of points.entries()) {
        if (seen.has(declared.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `two extension points are declared with the id "${declared.id}"`,
          });
        }
        seen.add(declared.id);
      }
    });
}

/**
 * The declared extensions over a given reading of one, each pair of plugin and
 * point once: an addon contributes once to each point it extends.
 */
export function declaredExtensionsSchema<
  T extends z.ZodType<{ plugin: string; point: string }>,
>(extension: T) {
  return z
    .array(extension)
    .max(MAX_EXTENSION_POINTS)
    .superRefine((extensions, ctx) => {
      const seen = new Set<string>();
      for (const [index, declared] of extensions.entries()) {
        const key = `${declared.plugin}/${declared.point}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "point"],
            message: `"${declared.point}" of "${declared.plugin}" is extended twice`,
          });
        }
        seen.add(key);
      }
    });
}

/** What the rules between a plugin's extension declarations read. */
export interface ExtensionDeclarations {
  readonly id: string;
  readonly permissions: readonly string[];
  readonly personalData: readonly string[];
  readonly extensionPoints: readonly {
    readonly personalData: readonly string[];
  }[];
  readonly extends: readonly {
    readonly plugin: string;
    readonly personalData: readonly string[];
  }[];
}

/**
 * The rules between a plugin's extension declarations and the rest of its
 * declaration (ADR 0030), as issues with the path each one is at.
 *
 * One function for the manifest and the catalog entry, so an entry the loader
 * would refuse is never offered for consent.
 */
export function extensionRuleIssues(
  declaration: ExtensionDeclarations,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const own = new Set(declaration.personalData);

  /*
   * One level. An addon that could be extended in turn would make "what can
   * reach this screen" a question the board could not answer from the two
   * consent screens in front of it.
   */
  if (
    declaration.extends.length > 0 &&
    declaration.extensionPoints.length > 0
  ) {
    issues.push({
      path: ["extensionPoints"],
      message:
        "a plugin that extends another declares no extension points of its own",
    });
  }

  for (const [index, point] of declaration.extensionPoints.entries()) {
    const foreign = point.personalData.filter((category) => !own.has(category));
    if (foreign.length > 0) {
      issues.push({
        path: ["extensionPoints", index, "personalData"],
        message: `${foreign.join(", ")} must be among the plugin's own personalData: what an addon hands a plugin is handled by it`,
      });
    }
    /*
     * What a website block renders is published to the street, and
     * `site:blocks` already keeps the address book away from such a plugin
     * (ADR 0006). A point that accepted names would be the same path through a
     * second plugin.
     */
    if (
      declaration.permissions.includes("site:blocks") &&
      point.personalData.length > 0
    ) {
      issues.push({
        path: ["extensionPoints", index, "personalData"],
        message:
          'a plugin that asks for "site:blocks" declares extension points that accept no personal data',
      });
    }
  }

  for (const [index, extension] of declaration.extends.entries()) {
    if (extension.plugin === declaration.id) {
      issues.push({
        path: ["extends", index, "plugin"],
        message: "a plugin does not extend itself",
      });
    }
    const foreign = extension.personalData.filter(
      (category) => !own.has(category),
    );
    if (foreign.length > 0) {
      issues.push({
        path: ["extends", index, "personalData"],
        message: `${foreign.join(", ")} must be among the plugin's own personalData`,
      });
    }
  }

  return issues;
}

/**
 * The permissions that read the register, which a plugin that puts blocks on
 * the website may not hold, and may not be handed data from (ADR 0006).
 */
const REGISTER_READ_PERMISSIONS: readonly string[] = [
  "addressBook:read",
  "addressBook:readContact",
];

/** The permissions in a list that read the register. */
function registerReadPermissions(permissions: readonly string[]): string[] {
  return permissions.filter((permission) =>
    REGISTER_READ_PERMISSIONS.includes(permission),
  );
}

/**
 * The register-read permissions that keep an addon and the plugin it extends
 * apart, or an empty list when there are none (ADR 0030): those of whichever
 * of the two does not ask for `site:blocks`, when the other does.
 *
 * A plugin that asks for `site:blocks` reads nothing in the register, so what
 * it publishes cannot name a resident. An extension is a path between two
 * plugins in both directions: the host hands the addon the point's input, and
 * the addon hands the host its output. A website host's points accept no
 * personal data, but an addon that reads the register could still return a
 * name in a field the point types as text, and only the addon's own
 * `personalData` would say it does not. A website addon extending a host that
 * reads the register could be handed names as the point's input, keep them,
 * and render them in a block. So the rule reads what each side can reach, from
 * the two manifests, rather than what either declares it hands over. Like the
 * rule on a single plugin, it holds an honest pair to the website's argument
 * rather than a hostile one.
 */
export function extensionPermissionsRefused(
  addon: { readonly permissions: readonly string[] },
  host: { readonly permissions: readonly string[] },
): string[] {
  return [
    ...(host.permissions.includes("site:blocks")
      ? registerReadPermissions(addon.permissions)
      : []),
    ...(addon.permissions.includes("site:blocks")
      ? registerReadPermissions(host.permissions)
      : []),
  ];
}

/**
 * The personal data a plugin handles that keeps an addon asking for
 * `site:blocks` off it, or an empty list when there is none (ADR 0030): the
 * host plugin's own `personalData`, when the addon asks for `site:blocks`.
 *
 * The point's input is the one thing that crosses an extension and that no
 * manifest declares. A host plugin that reads nothing in the register can
 * still be handed names by another of its addons, and then hand them on as a
 * point's input. A host plugin that handles no personal data has none to hand
 * on, so a website addon extends only such a plugin.
 */
export function extensionHostPersonalDataRefused(
  addon: { readonly permissions: readonly string[] },
  host: { readonly personalData: readonly string[] },
): string[] {
  return addon.permissions.includes("site:blocks")
    ? [...host.personalData]
    : [];
}

/** What the rule on a group of plugins joined by extensions reads. */
export interface ExtensionGroupMember {
  readonly id: string;
  readonly permissions: readonly string[];
  readonly extends: readonly { readonly plugin: string }[];
}

/** Why an addon's group keeps it from serving. */
export interface ExtensionGroupRefusal {
  /** The plugins in its group that ask for `site:blocks`. */
  readonly website: string[];
  /** The plugins in its group that read the register. */
  readonly register: string[];
}

/**
 * The plugins joined to one another by extensions, each group in the order
 * of `members`. An extension joins an addon to its host plugin whichever way
 * data crosses it, and an addon that extends two plugins joins both groups.
 */
function extensionGroups<Member extends ExtensionGroupMember>(
  members: readonly Member[],
): Member[][] {
  const root = new Map(members.map((member) => [member.id, member.id]));
  const find = (id: string): string => {
    let current = id;
    let parent = root.get(current);
    while (parent !== undefined && parent !== current) {
      current = parent;
      parent = root.get(current);
    }
    return current;
  };
  for (const member of members) {
    for (const extension of member.extends) {
      if (root.has(extension.plugin)) {
        root.set(find(member.id), find(extension.plugin));
      }
    }
  }
  const groups = new Map<string, Member[]>();
  for (const member of members) {
    const group = groups.get(find(member.id)) ?? [];
    group.push(member);
    groups.set(find(member.id), group);
  }
  return [...groups.values()];
}

/**
 * Which addons give way, in turn, while a group still holds both a plugin
 * that asks for `site:blocks` and one that reads the register: the website
 * addons first, then the addons that read the register, then the addons that
 * join two of the group's plugins. The host plugins never do, because every
 * other addon of theirs would go with them; once the addons of the first two
 * kinds are gone, the two sides are host plugins, and what still joins them
 * is an addon that extends both.
 */
const GROUP_YIELDS: readonly ((
  member: ExtensionGroupMember,
  standing: ReadonlySet<string>,
) => boolean)[] = [
  (member) => member.permissions.includes("site:blocks"),
  (member) => registerReadPermissions(member.permissions).length > 0,
  (member, standing) =>
    new Set(
      member.extends
        .map((extension) => extension.plugin)
        .filter((plugin) => standing.has(plugin)),
    ).size > 1,
];

/**
 * The addons refused because the plugins joined to them by extensions hold
 * both a plugin that asks for `site:blocks` and one that reads the register,
 * by id (ADR 0030).
 *
 * The rule between an addon and its host plugin reads two manifests. Data
 * also crosses between two addons of one host plugin, and further: an addon
 * that reads the register hands the host plugin a name while declaring
 * nothing, the host plugin hands it to a website addon as a point's input,
 * and the website addon renders it. Neither manifest of any one pair says so.
 * So the plugins joined by extensions, through one host plugin or several,
 * are read as one group, and a group never holds both kinds.
 *
 * The answer depends only on the set of members, never on their order, so it
 * is the same whichever order the loader finds the packages in. Addons give
 * way in the order of `GROUP_YIELDS`, which keeps the plugin that reads the
 * register serving and refuses the website addon beside it.
 */
export function extensionGroupRefusals(
  members: readonly ExtensionGroupMember[],
): Map<string, ExtensionGroupRefusal> {
  const refused = new Map<string, ExtensionGroupRefusal>();
  for (const yields of GROUP_YIELDS) {
    const standing = members.filter((member) => !refused.has(member.id));
    const ids = new Set(standing.map((member) => member.id));
    for (const group of extensionGroups(standing)) {
      const website = group
        .filter((member) => member.permissions.includes("site:blocks"))
        .map((member) => member.id);
      const register = group
        .filter(
          (member) => registerReadPermissions(member.permissions).length > 0,
        )
        .map((member) => member.id);
      if (website.length === 0 || register.length === 0) {
        continue;
      }
      for (const member of group) {
        if (member.extends.length > 0 && yields(member, ids)) {
          refused.set(member.id, { website, register });
        }
      }
    }
  }
  return refused;
}

export const pluginManifestSchema = z
  .object({
    /**
     * The contract version this plugin was built against. The loader refuses
     * anything it does not implement rather than loading it and hoping.
     */
    apiVersion: z.int().min(1),
    id: pluginIdSchema,
    entry: pluginEntrySchema,
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(16).default([]),
    personalData: z
      .array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES))
      .max(16)
      .default([]),
    settingsSchema: pluginSettingsSchema.optional(),
    /**
     * The plugin's own screen in the application, when it has one, at
     * `/plugin/<id>`. The title is an i18n key in the plugin's own namespace.
     */
    view: pluginViewSchema.optional(),
    /** What this plugin proposes the platform be able to do. */
    actions: pluginActionsSchema.default([]),
    /**
     * The route, under this plugin's own mount, that serves MCP.
     *
     * Declaring it makes that route the instance's OAuth protected resource:
     * its full URL becomes the audience every issued token is bound to, the
     * discovery documents point at it, and the route stops accepting the
     * browser's session cookie and accepts only a Bearer token issued for it.
     *
     * At most one installed plugin may declare it, because the audience is a
     * single URL and moving it would strand every token already issued. A
     * second one is refused at install.
     */
    oauthProtectedResource: pluginRoutePathSchema.optional(),
    /**
     * The blocks this plugin adds to the association's website.
     *
     * Declared here rather than at registration for the reason actions are:
     * the board consents to what a plugin may put on the website before any of
     * its code has run. A plugin declaring one asks for `site:blocks`.
     */
    blocks: pluginBlocksSchema.default([]),
    /**
     * The extension points this plugin offers other plugins (ADR 0030). At
     * most eight.
     */
    extensionPoints: declaredExtensionPointsSchema(
      pluginExtensionPointSchema,
    ).default([]),
    /**
     * The extension points of other plugins this plugin extends, which makes
     * it an addon (ADR 0030). At most eight.
     */
    extends: declaredExtensionsSchema(pluginExtensionSchema).default([]),
  })
  .superRefine((manifest, ctx) => {
    for (const issue of extensionRuleIssues(manifest)) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }

    /*
     * A block is published on the website, to readers with no account, so it
     * is something the board consents to by name rather than something a
     * plugin acquires by declaring it. The permission is what the install
     * consent screen shows; the declarations are what the host registers.
     */
    if (
      manifest.blocks.length > 0 &&
      !manifest.permissions.includes("site:blocks")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["blocks"],
        message:
          'a plugin that declares blocks must ask for the "site:blocks" permission',
      });
    }
    /*
     * And a plugin that puts blocks on the website does not read the
     * register. The website's argument that it cannot publish a resident's
     * details rests on there being no path from it to the register (ADR 0006),
     * and a block that could ask the address book what to print would be one.
     * Permissions are not a sandbox, so this holds an honest plugin to that
     * argument rather than a hostile one; curation does the rest.
     */
    if (
      manifest.permissions.includes("site:blocks") &&
      registerReadPermissions(manifest.permissions).length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message:
          'a plugin that asks for "site:blocks" may not also read the address book: what a block renders is published to anybody',
      });
    }

    /*
     * The composed name has to fit the public pattern, and only the pair can
     * know whether it does: a plugin id runs to 48 characters and an action id to
     * 32, which composes to 81 against a limit of 64. Checked pairwise rather
     * than by shortening the action id to a worst case, because that would charge
     * every plugin for the longest possible plugin id and forbid
     * `monthly_occupancy_report` to a plugin called `brf`, where the composed
     * name is 28 characters.
     *
     * Refused here rather than at registration so that it is manifest-invalid
     * before the install consent screen, instead of a finding after the plugin's
     * code has already run.
     */
    for (const [index, action] of manifest.actions.entries()) {
      const composed = composedActionName(manifest.id, action.id);
      if (!ACTION_NAME_PATTERN.test(composed)) {
        ctx.addIssue({
          code: "custom",
          path: ["actions", index, "id"],
          message: `the public name "${composed}" is ${String(composed.length)} characters; a plugin id and an action id compose to at most 64`,
        });
      }
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginActionDeclaration = z.infer<typeof pluginActionSchema>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;
export type PluginView = z.infer<typeof pluginViewSchema>;
export type PluginExtensionPointDeclaration = z.infer<
  typeof pluginExtensionPointSchema
>;
export type PluginExtensionDeclaration = z.infer<typeof pluginExtensionSchema>;

/**
 * Dependency fields npm installs at install time.
 *
 * The installer omits peer, dev and optional dependencies and runs no scripts,
 * but it still hands npm the package: anything listed here would send that npm
 * to a registry, which an instance never contacts. optionalDependencies is
 * listed although it is omitted, because a package relying on one being
 * present works in development and quietly not on an instance.
 */
export const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

/** Package names in a dependency field, whether a map or npm's bundle list. */
export function dependencyNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((name): name is string => typeof name === "string");
  }
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/** Whether a dependency field is an empty map or an empty list. */
export function isEmptyDependencyField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 0
  );
}

/**
 * A dependency field that names nothing: absent, an empty map or an empty
 * list. Anything else is refused, a string included, since npm reads even
 * that as something to install. See RUNTIME_DEPENDENCY_FIELDS for why.
 *
 * Part of the schema rather than a check beside it, so the loader refuses such
 * a package at boot as well as the catalog refusing to list it.
 */
const noRuntimeDependencies = z
  .unknown()
  .superRefine((value, ctx) => {
    const names = dependencyNames(value);
    if (names.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `names ${names.join(", ")}; a plugin declares no runtime dependencies, because the installer resolves nothing from a registry`,
      });
    } else if (!isEmptyDependencyField(value)) {
      ctx.addIssue({
        code: "custom",
        message:
          "is neither an empty map nor an empty list; a plugin declares no runtime dependencies, because the installer resolves nothing from a registry",
      });
    }
  })
  .optional();

/**
 * The subset of package.json the loader reads. Everything else in the file is
 * npm's business, apart from the dependency fields, which must name nothing.
 */
export const pluginPackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  openbrf: pluginManifestSchema,
  dependencies: noRuntimeDependencies,
  optionalDependencies: noRuntimeDependencies,
  bundleDependencies: noRuntimeDependencies,
  bundledDependencies: noRuntimeDependencies,
});

export type PluginPackage = z.infer<typeof pluginPackageSchema>;

export interface ManifestParseFailure {
  ok: false;
  /** One line per problem, already naming the field. */
  issues: string[];
}

export type ManifestParseResult =
  { ok: true; value: PluginPackage } | ManifestParseFailure;

/**
 * Parses a plugin's package.json.
 *
 * Returns a result rather than throwing, because the only caller that matters
 * is the boot-time scan, and a malformed plugin directory must be skipped and
 * reported rather than being allowed to take the register offline (ADR 0003).
 * A thrown error would make "skip and report" the caller's discipline instead
 * of the function's contract.
 */
export function parsePluginPackage(input: unknown): ManifestParseResult {
  const result = pluginPackageSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

/** Convenience for a plugin's own CI: throws with every problem at once. */
export function assertPluginPackage(input: unknown): PluginPackage {
  const result = parsePluginPackage(input);
  if (!result.ok) {
    throw new Error(
      `Invalid Open BRF plugin manifest:\n  ${result.issues.join("\n  ")}`,
    );
  }
  return result.value;
}

/** The api version a plugin authored against this SDK should declare. */
export const CURRENT_PLUGIN_API_VERSION = PLUGIN_API_VERSION;
