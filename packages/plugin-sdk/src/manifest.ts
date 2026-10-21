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
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
} from "./permissions.ts";
import { pluginRecipientsSchema } from "./recipients.ts";
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

/**
 * A calendar date written `YYYY-MM-DD`, and a real one: `2027-02-30` is
 * refused rather than rolled over into March.
 */
export function isCalendarDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

const calendarDaySchema = z
  .string()
  .refine(isCalendarDay, "must be a calendar date, YYYY-MM-DD");

/**
 * Which of an issuer's keys signed a licence (ADR 0042).
 *
 * It selects the keys to try and asserts nothing: two plugins may declare one
 * key id with different keys, and a key is known by its fingerprint.
 */
export const licenceKeyIdSchema = z
  .string()
  .regex(
    /^[a-z0-9-]{1,64}$/,
    "must be 1 to 64 lowercase letters, digits and hyphens",
  );

/**
 * An Ed25519 public key: the base64 of its 32 raw bytes, padded, and in the
 * one spelling that decodes to them. The last character before the padding
 * carries two bits no key has, which is what the class of letters it may be
 * from says.
 */
export const licencePublicKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/,
    "must be the base64 of a 32-byte Ed25519 public key",
  );

/**
 * A service a plugin may present the instance's licence to: an `https` origin
 * as the WHATWG URL standard serialises one, so it compares exactly.
 *
 * A lower-case domain in punycode, a port only when it is not 443, and no
 * userinfo, path, query or fragment. A host whose last label is a number is
 * an IPv4 address to that standard, which serialises it otherwise, so it is
 * refused rather than compared in a form no browser would print. Plain `http`
 * is refused too: a presentation sent in the clear could be replayed before
 * the service saw its nonce.
 */
export const licenceAudienceSchema = z
  .string()
  .max(256)
  .refine(isCanonicalHttpsOrigin, {
    error:
      "must be an https origin in its canonical form, such as https://themes.example.org",
  });

function isCanonicalHttpsOrigin(value: string): boolean {
  const match =
    /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?$/.exec(
      value,
    );
  if (match === null) {
    return false;
  }
  const host = match[1] ?? "";
  const lastLabel = host.slice(host.lastIndexOf(".") + 1);
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(lastLabel) || host.length > 253) {
    return false;
  }
  const port = match[2];
  return port === undefined || (Number(port) <= 65535 && port !== "443");
}

/**
 * The licence a paid plugin reads (ADR 0042), and whom it trusts to issue it.
 *
 * The keys sit here rather than in the core, so the core holds no vendor's
 * key and anyone who sells a plugin can issue licences for it in the same
 * format. The host verifies; a plugin reads the result through
 * `host.entitlements`.
 *
 * Strict, because what it grants is consented to: a misspelled field read as
 * absent would be a declaration the board never saw.
 */
export const pluginLicenceSchema = z.strictObject({
  /**
   * The one entitlement the plugin reads, named as a plugin id is. A licence
   * may carry several; the host reports this one only.
   */
  entitlement: pluginIdSchema,
  /**
   * Who issues the licence. The licence screen and the audit log name the
   * issuer from here, never from text in a licence file.
   */
  issuer: z.strictObject({
    name: z.string().min(1).max(100),
    url: z
      .string()
      .max(2000)
      .regex(/^https:\/\/[^\s/?#]+(?:\/\S*)?$/, "must be an https address"),
  }),
  /**
   * The issuer's public keys by key id. At most two at once: a new key is
   * declared in a release before any licence is signed with it, and the old
   * one leaves in a later release.
   */
  keys: z.record(licenceKeyIdSchema, licencePublicKeySchema).refine((keys) => {
    const count = Object.keys(keys).length;
    return count >= 1 && count <= 2;
  }, "must declare one or two keys"),
  /**
   * The services of the issuer's the plugin may present the licence to.
   * None for a plugin that uses no service of its issuer's.
   */
  audiences: z
    .array(licenceAudienceSchema)
    .max(8)
    .refine(
      (audiences) => new Set(audiences).size === audiences.length,
      "must not name an audience twice",
    )
    .default([]),
});

export type PluginLicenceDeclaration = z.infer<typeof pluginLicenceSchema>;

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
     * That this plugin is an AI package: a language model chooses the actions
     * it dispatches, for the person whose request its route is serving.
     *
     * Declaring it moves the plugin's dispatch onto the `ai` audit channel and
     * the `ai` surface. Its writes are recorded as made through the AI package
     * rather than as any plugin's; it reaches only the actions offered on `ai`;
     * and a plugin action is reached only once an administrator has armed it,
     * as on `mcp`. A connected app's token on its route keeps `mcp`.
     *
     * It narrows what the plugin can reach and never widens it, and it is the
     * only say a plugin has in its channel. The host derives the channel from
     * this declaration and from how the request arrived; nothing a plugin
     * passes to `host.actions` names one. The consent screen shows it.
     */
    ai: z.boolean().default(false),
    /**
     * The blocks this plugin adds to the association's website.
     *
     * Declared here rather than at registration for the reason actions are:
     * the board consents to what a plugin may put on the website before any of
     * its code has run. A plugin declaring one asks for `site:blocks`.
     */
    blocks: pluginBlocksSchema.default([]),
    /**
     * Where the plugin connects to outside the instance, and which personal
     * data each place receives (ADR 0037).
     *
     * Shown on the install consent screen, where it fills in the question
     * about where the plugin sends personal data, and consented to as a
     * snapshot: a republished version that adds a recipient, moves one or
     * sends one more is refused at load until the board consents again.
     */
    recipients: pluginRecipientsSchema.default([]),
    /**
     * The licence this plugin reads, for a paid plugin (ADR 0042).
     *
     * Declaring it gives the plugin `host.entitlements`. Nothing else in the
     * host reads it: the plugin loads and serves either way, and what it
     * withholds without an active entitlement is its own decision.
     */
    licence: pluginLicenceSchema.optional(),
    /**
     * The day this release was published, written by the release workflow and
     * compared with a licence's `updatesUntil`. Required with `licence`.
     */
    released: calendarDaySchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    /*
     * A licence sold with a year of updates covers the releases published in
     * that year, and a release that does not say when it was published cannot
     * be judged. Refused here rather than read as covered, which would make
     * every licence for updates cover every release.
     */
    if (manifest.licence !== undefined && manifest.released === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["released"],
        message:
          "a plugin that declares a licence must say when it was released",
      });
    }
    /*
     * What a recipient receives is part of what the plugin handles, so it is
     * among the categories the plugin declares. A recipient naming one the
     * manifest does not would put a category on the consent screen, and into
     * the record of who receives what, that the record of processing
     * activities never hears about.
     */
    const handled = new Set<string>(manifest.personalData);
    for (const [index, recipient] of manifest.recipients.entries()) {
      for (const [at, category] of recipient.personalData.entries()) {
        if (!handled.has(category)) {
          ctx.addIssue({
            code: "custom",
            path: ["recipients", index, "personalData", at],
            message: `"${category}" is not among the plugin's own personalData; a recipient receives only what the plugin declares it handles`,
          });
        }
      }
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
     * So would one that could ask the finances: a fee notice and a charge carry
     * the names of the people they are for. Permissions are not a sandbox, so
     * this holds an honest plugin to that argument rather than a hostile one;
     * curation does the rest.
     */
    if (
      manifest.permissions.includes("site:blocks") &&
      (manifest.permissions.includes("addressBook:read") ||
        manifest.permissions.includes("addressBook:readContact") ||
        manifest.permissions.includes("finances:read"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message:
          'a plugin that asks for "site:blocks" may not also read the address book or the finances: what a block renders is published to anybody',
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
