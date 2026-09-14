import { z } from "zod";

import {
  ACTION_EFFECTS,
  ACTION_NAME_PATTERN,
  ACTION_PERSONAL_DATA,
  ACTION_SURFACES,
} from "./actions.ts";
import { PLUGIN_API_VERSION } from "./api-version.ts";
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
     * Prebuilt CJS bundle whose only externals are host packages (ADR 0003).
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
export const pluginActionsSchema = z
  .array(pluginActionSchema)
  .max(16)
  .superRefine((actions, ctx) => {
    const seen = new Set<string>();
    for (const [index, action] of actions.entries()) {
      if (seen.has(action.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `two actions are declared with the id "${action.id}"`,
        });
      }
      seen.add(action.id);
    }
  });

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
     * Where the view is mounted in the admin interface, when the plugin has
     * one. The label is an i18n key in the plugin's own namespace.
     */
    view: z
      .object({
        /** Named export of the remote module, per Module Federation. */
        module: z.string().min(1).max(100).default("./View"),
        titleKey: z.string().min(1).max(200),
      })
      .optional(),
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
  })
  .superRefine((manifest, ctx) => {
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

/**
 * The subset of package.json the loader reads. Everything else in the file is
 * npm's business.
 */
export const pluginPackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  openbrf: pluginManifestSchema,
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
