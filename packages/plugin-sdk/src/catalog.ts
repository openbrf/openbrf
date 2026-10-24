import { z } from "zod";

import type { PluginFindingDetail, PluginFindingReason } from "./findings.ts";
import { IntegrityError, parseSha512 } from "./integrity.ts";
import { localizedTextSchema } from "./localized-text.ts";
import {
  declaredActionsSchema,
  declaredPersonRecordsSchema,
  missingProcessingProblem,
  personRecordsRuleIssues,
  pluginPersonRecordCollectionSchema,
  undeclaredPersonalDataProblem,
  declaredExtensionPointsSchema,
  declaredExtensionsSchema,
  extensionGroupRefusals,
  extensionHostPersonalDataRefused,
  extensionPermissionsRefused,
  extensionPointRefusal,
  type ExtensionPointRefusal,
  extensionRuleIssues,
  pluginExtensionPointSchema,
  pluginExtensionSchema,
  declaredDeviceRoutesSchema,
  deviceRouteRuleIssues,
  pluginActionSchema,
  pluginDeviceRouteSchema,
  pluginIdSchema,
  pluginManifestSchema,
  pluginProcessingSchema,
  proposeImportPersonalDataIssues,
} from "./manifest.ts";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
} from "./permissions.ts";
import {
  declaredRecipientsSchema,
  pluginRecipientSchema,
  recipientCategoryIssues,
} from "./recipients.ts";

/**
 * The catalog index.
 *
 * One file listing everything an instance may install: plugins and themes
 * alike, since both are distributed the same way and the board browses one
 * screen per kind rather than one source per kind. Delisting is a commit
 * against the index, which is why an instance re-reads it rather than caching
 * it across installs.
 *
 * Exported so the index is checked by the same schema wherever it is read: by
 * the instance before it offers an entry to a board, and by the catalog's own
 * check before a listing is merged.
 *
 * Entries are parsed strictly. The index arrives over the network, and an
 * entry the instance does not fully understand is an entry it must not offer
 * to a board for consent - the consent screen's whole job is to say precisely
 * what is being agreed to.
 *
 * Every object in it is strict as well: a field this version of the index does
 * not define is refused, never dropped. Dropped, a misspelled field of the
 * declaration would be replaced by its default before the consent screen or
 * any check of the manifest saw it. The index carries its version for exactly
 * this, so a new field is a new index version rather than a key an older
 * instance ignores.
 *
 * An instance reads both versions there are. Version 2 adds the device routes
 * of ADR 0031, the processing declaration of ADR 0035 and the records about a
 * person of ADR 0047 to a plugin entry, and the other fields of ADR 0030 join them there as they are built; version 1 is
 * the index as it stood before, which a catalog keeps serving to instances that
 * read nothing newer.
 */

/** Whether `declared` is a digest `parseSha512` can read. */
function isReadableSha512(declared: string): boolean {
  try {
    parseSha512(declared);
    return true;
  } catch (error) {
    if (error instanceof IntegrityError) {
      return false;
    }
    throw error;
  }
}

/** A tarball and the digest its bytes must hash to. */
export const catalogArtifactSchema = z.strictObject({
  /**
   * Direct URL.
   *
   * https on a curated instance, and nothing else: the shape is checked here
   * but the destination is decided at fetch time, where http: and file: are
   * refused unless the instance has opted out of curation. That is what keeps
   * an entry - which is data fetched from elsewhere - from naming a `file:`
   * path and having the instance read its own disk, or a plain-http address
   * inside the network the instance sits in.
   */
  url: z.string().min(1).max(2000),
  /**
   * "sha512-<base64>" or 128 hex characters.
   *
   * Read through the same `parseSha512` the instance verifies a download with,
   * so an entry the catalog's check lets through is one the instance can read,
   * and an index with a badly spelled digest is refused by `parseCatalogIndex`
   * alone.
   */
  sha512: z.string().min(1).max(200).refine(isReadableSha512, {
    error:
      'Expected a digest written as "sha512-<base64>" or 128 hex characters.',
  }),
  bytes: z.int().min(1).optional(),
});

export type CatalogArtifact = z.infer<typeof catalogArtifactSchema>;

export type { LocalizedText } from "./localized-text.ts";

/**
 * An extension point as the index lists it: the manifest's fields, and the
 * curator's title and description in both languages.
 *
 * The text is the curator's rather than the plugin's own, as an entry's `name`
 * is, because an addon's consent screen has to name the point before the host
 * plugin's locale files exist on the instance (ADR 0030).
 */
export const catalogExtensionPointSchema = pluginExtensionPointSchema
  .extend({
    title: localizedTextSchema,
    description: localizedTextSchema,
  })
  .strict();

export type CatalogExtensionPoint = z.infer<typeof catalogExtensionPointSchema>;

/** Strict, and `.extend()` keeps it so for both kinds of entry. */
const baseEntrySchema = z.strictObject({
  /**
   * Unique across the whole index, whatever the entry's type: an install
   * looks an entry up by id alone.
   */
  id: pluginIdSchema,
  version: z.string().min(1).max(64),
  /** The curator's text, in both languages the interface is offered in. */
  name: localizedTextSchema,
  description: localizedTextSchema,
  artifact: catalogArtifactSchema,
  homepage: z.string().max(2000).optional(),
  /** Set on an entry that is still listed but should not be installed anew. */
  deprecated: z.boolean().default(false),
});

export const catalogPluginEntrySchema = baseEntrySchema
  .extend({
    type: z.literal("plugin"),
    /**
     * The npm package name the tarball unpacks as. Needed because the installer
     * writes a dependency set for npm, which keys on the package name and not on
     * the catalog id.
     */
    packageName: z.string().min(1).max(214),
    /** Gated against the host's own contract version before an install starts. */
    apiVersion: z.int().min(1),
    /**
     * Repeated from the plugin's manifest so the consent screen can be shown
     * before anything is downloaded. The installed manifest is authoritative:
     * the loader compares the two and refuses a plugin that asks for more than
     * the board consented to.
     */
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(16).default([]),
    personalData: z
      .array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES))
      .max(16)
      .default([]),
    /**
     * The actions the plugin proposes, on the same terms as the two above.
     *
     * The widest part of the declaration, and so the part the consent screen
     * most needs before anything is downloaded: an action names a capability and
     * offers it to callers the board decides on.
     *
     * The manifest's own action fields and its own uniqueness rule, not a
     * second array of the same thing: the rule on the ids has to hold at
     * whichever boundary is read first, and two copies is two places for it to
     * stop holding. Read strictly here, as everything in the index is.
     */
    actions: declaredActionsSchema(pluginActionSchema.strict()).default([]),
    /**
     * The route that serves MCP, repeated on the same terms as the three above.
     *
     * Both rules about it are decided before anything is downloaded - a second
     * plugin declaring it is refused, and the reserved id `mcp-connector` may be
     * taken only by a plugin that does declare it - so the index has to carry it.
     * The manifest's own field schema rather than a second spelling of it: the
     * value becomes a URL an unauthenticated caller is pointed at, and one
     * definition of what it may contain is the point of that schema.
     */
    oauthProtectedResource: pluginManifestSchema.shape.oauthProtectedResource,
    /**
     * The extension points the plugin offers, repeated from the manifest with
     * the curator's text, so the host plugin's consent screen can say what its
     * points accept before anything is downloaded (ADR 0030).
     *
     * In version 2 of the index only; see `catalogSchema`. Left without a
     * default, so that a version 1 index carrying the key, even empty, can be
     * told from one that does not.
     */
    extensionPoints: declaredExtensionPointsSchema(
      catalogExtensionPointSchema,
    ).optional(),
    /**
     * The extension points of other plugins it extends, repeated on the same
     * terms, so an addon's consent screen can say what it extends and what it
     * hands over. Version 2 only.
     */
    extends: declaredExtensionsSchema(
      pluginExtensionSchema.strict(),
    ).optional(),
    /**
     * Where the plugin connects to, repeated on the same terms as the
     * declaration above it (ADR 0037).
     *
     * A field version 1 of the index does not define, so only an index of
     * version 2 may carry it, and an index of version 1 that does is refused.
     * Absent rather than defaulted, so that rule can tell an entry that left it
     * out from one that declared none; a reader takes absent as none.
     */
    recipients: declaredRecipientsSchema(
      pluginRecipientSchema.strict(),
    ).optional(),
    /**
     * The routes a device reaches with a device token, repeated on the same
     * terms (ADR 0031).
     *
     * The consent screen names them - "can be reached by devices holding a token
     * the board issues" - before anything is downloaded. In version 2 of the
     * index only; see `catalogSchema`. Left without a default, so that a version 1
     * index carrying the key, even empty, can be told from one that does not.
     */
    deviceRoutes: declaredDeviceRoutesSchema(
      pluginDeviceRouteSchema.strict(),
    ).optional(),
    /**
     * That the plugin is an AI package, repeated on the same terms.
     *
     * It decides what the plugin's dispatch reaches and how the audit log names
     * its writes, so the board reads it on the consent screen, and the install
     * echo compares it, before anything is downloaded.
     *
     * Added within version 1 of the index rather than as a new version, because
     * absent means the same as false: an index that lists no AI package need not
     * carry the field and stays one an older instance reads. One that lists an
     * AI package is refused whole by an older instance, which is the rule above
     * doing its work - that instance would otherwise offer the plugin for
     * consent without saying what it is, and dispatch it as a plain plugin.
     */
    ai: pluginManifestSchema.shape.ai,
    /**
     * The licence a paid plugin reads, repeated on the same terms (ADR 0042).
     *
     * Above all its `audiences`: the services the plugin may present the
     * association's licence to are a grant the board consents to, as it does
     * `permissions`, so the consent screen states them and the install echo
     * compares them before anything is downloaded. The manifest's own strict
     * schema, so a misspelled field is refused here as it is there.
     *
     * Added within version 1 of the index on the `ai` field's terms: absent
     * means the plugin reads no licence, and an index that lists a licensed
     * plugin is refused whole by an instance from before the field.
     */
    licence: pluginManifestSchema.shape.licence,
    /**
     * The day the release was published, which the update screen compares with
     * the `updatesUntil` of the licence the instance holds. Required with
     * `licence`, as in the manifest.
     */
    released: pluginManifestSchema.shape.released,
  })
  .superRefine((entry, ctx) => {
    if (entry.licence !== undefined && entry.released === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["released"],
        message:
          "an entry that declares a licence must say when it was released",
      });
    }
  });

/**
 * A plugin entry in version 2 of the index: version 1's, and the processing
 * declaration.
 *
 * Repeated from the manifest on the terms the permissions are, because the
 * consent screen shows it before anything is downloaded and the install seeds
 * the record of processing activities from what that screen showed. Whether it
 * is there is decided with the personal data, by the index as a whole below,
 * since a refined object cannot be extended into the next version's entry.
 */
export const catalogPluginEntryV2Schema = catalogPluginEntrySchema.extend({
  processing: pluginProcessingSchema.optional(),
  /**
   * The collections of records about a person (ADR 0047), in the version that
   * carries `processing`: the consent screen shows each with its categories
   * and its bound before anything is downloaded, and a plugin that keeps one
   * declares its processing.
   */
  personRecords: declaredPersonRecordsSchema(
    pluginPersonRecordCollectionSchema,
  ).optional(),
});

/**
 * A theme entry. Themes install through the same download-and-verify path and
 * are listed in the same index; what happens after the bytes are verified is
 * the theme installer's business, not this schema's.
 *
 * No package name: a theme is data read out of its archive, never an npm
 * package, and nothing that installs one keys on a package name.
 */
export const catalogThemeEntrySchema = baseEntrySchema.extend({
  type: z.literal("theme"),
  /** The token contract range the theme was authored against. */
  contract: z.string().min(1).max(64).optional(),
  /** The theme it inherits from, as its manifest names it. */
  extends: z.string().min(1).max(64).optional(),
});

export const catalogEntrySchema = z.discriminatedUnion("type", [
  catalogPluginEntrySchema,
  catalogThemeEntrySchema,
]);

export const catalogEntryV2Schema = z.discriminatedUnion("type", [
  catalogPluginEntryV2Schema,
  catalogThemeEntrySchema,
]);

/**
 * A plugin entry, as whichever version of the index it came from. A version 1
 * entry is one with no processing and no device routes declared.
 */
export type CatalogPluginEntry = z.infer<typeof catalogPluginEntryV2Schema>;
export type CatalogThemeEntry = z.infer<typeof catalogThemeEntrySchema>;
export type CatalogEntry = CatalogPluginEntry | CatalogThemeEntry;

/** The index's rules about its entries taken together, in either version. */
function checkEntries(
  catalog: { version: 1 | 2; entries: readonly CatalogEntry[] },
  ctx: z.RefinementCtx,
): void {
  for (const [index, entry] of catalog.entries.entries()) {
    if (entry.type !== "plugin") {
      continue;
    }
    // The manifest's rule, so an entry the loader would refuse is never
    // offered for consent.
    for (const issue of proposeImportPersonalDataIssues(entry)) {
      ctx.addIssue({
        code: "custom",
        path: ["entries", index, "personalData"],
        message: issue.message,
      });
    }
  }

  for (const [index, entry] of catalog.entries.entries()) {
    if (entry.type !== "plugin") {
      continue;
    }
    /*
     * A field version 1 does not define is refused there as any unknown key
     * is, so an older instance and this one read the same index the same
     * way.
     */
    if (catalog.version === 1) {
      for (const field of [
        "extensionPoints",
        "extends",
        "deviceRoutes",
      ] as const) {
        if (entry[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", index, field],
            message: `${field} needs version 2 of the index`,
          });
        }
      }
      continue;
    }
    // The manifest's own rules, so an entry whose own declaration breaks
    // one is never offered for consent.
    for (const issue of extensionRuleIssues({
      id: entry.id,
      permissions: entry.permissions,
      personalData: entry.personalData,
      deviceRoutes: entry.deviceRoutes ?? [],
      extensionPoints: entry.extensionPoints ?? [],
      extends: entry.extends ?? [],
    })) {
      ctx.addIssue({
        code: "custom",
        path: ["entries", index, ...issue.path],
        message: issue.message,
      });
    }
    // The manifest's own rules, so an entry that the loader would refuse is
    // never offered for consent.
    for (const issue of deviceRouteRuleIssues({
      deviceRoutes: entry.deviceRoutes ?? [],
      oauthProtectedResource: entry.oauthProtectedResource,
      permissions: entry.permissions,
    })) {
      ctx.addIssue({
        code: "custom",
        path: ["entries", index, ...issue.path],
        message: issue.message,
      });
    }
  }

  /*
   * A field is in the version that defines it and in no earlier one: an
   * instance that reads only version 1 would refuse the entry, and an index
   * claiming version 1 while carrying it is not one such an instance could
   * read.
   */
  if (catalog.version === 1) {
    for (const [index, entry] of catalog.entries.entries()) {
      if (entry.type === "plugin" && entry.recipients !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "recipients"],
          message:
            "recipients is not in version 1 of the index; an entry that declares them is listed in version 2",
        });
      }
    }
  }

  /*
   * The manifest's rule on what a recipient may receive, so an entry the
   * loader would refuse is not offered for consent with a category the
   * plugin does not declare it handles. The comparison with the installed
   * manifest comes later; this holds the entry to itself.
   */
  for (const [index, entry] of catalog.entries.entries()) {
    if (entry.type !== "plugin" || entry.recipients === undefined) {
      continue;
    }
    for (const issue of recipientCategoryIssues(
      entry.recipients,
      entry.personalData,
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["entries", index, ...issue.path],
        message: issue.message,
      });
    }
  }

  /*
   * An id names one entry in the whole index, not one per type. An install
   * finds its entry by id and then refuses one of the wrong type, so a theme
   * sharing a plugin's id would leave that plugin impossible to install, and
   * which of the two a board got would depend on the order of the file.
   */
  const firstIndexById = new Map<string, number>();
  for (const [index, entry] of catalog.entries.entries()) {
    const first = firstIndexById.get(entry.id);
    if (first === undefined) {
      firstIndexById.set(entry.id, index);
      continue;
    }
    ctx.addIssue({
      code: "custom",
      path: ["entries", index, "id"],
      message: `"${entry.id}" is already the id of entry ${String(first)}; an id appears once in the index`,
    });
  }
}

const catalogV1Schema = z
  .strictObject({
    /** Index format version, so a future shape can be recognised and refused. */
    version: z.literal(1),
    entries: z.array(catalogEntrySchema).max(500),
  })
  .superRefine((catalog, ctx) => {
    checkEntries(catalog, ctx);
  });

const catalogV2Schema = z
  .strictObject({
    /**
     * Version 2 adds the fields `CATALOG_INDEX_VERSIONS` lists to a plugin
     * entry, `processing` (ADR 0035) among them, and changes nothing else.
     * This package reads both versions; the catalog keeps serving version 1,
     * without the entries that need version 2, to instances that have not
     * upgraded.
     */
    version: z.literal(2),
    entries: z.array(catalogEntryV2Schema).max(500),
  })
  .superRefine((catalog, ctx) => {
    checkEntries(catalog, ctx);
    const plugins = new Map<string, CatalogPluginEntry>();
    const pluginIndex = new Map<string, number>();
    for (const [index, entry] of catalog.entries.entries()) {
      if (entry.type === "plugin" && !plugins.has(entry.id)) {
        plugins.set(entry.id, entry);
        pluginIndex.set(entry.id, index);
      }
    }
    /** The addons already refused beside a plugin they extend. */
    const pairRefused = new Set<string>();
    /*
     * The manifest's own rule, both ways: an entry that declares personal data
     * declares its processing, and one that declares none declares no
     * processing. One that reads the address book declares personal data, so
     * it has a processing a person can object to. Held here rather than only
     * by the catalog's check of the package, so an index written by hand is
     * held to it as well.
     */
    for (const [index, entry] of catalog.entries.entries()) {
      if (entry.type !== "plugin") {
        continue;
      }
      const missing = missingProcessingProblem(entry);
      if (missing !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "processing"],
          message: missing,
        });
      }
      const undeclared = undeclaredPersonalDataProblem(entry);
      if (undeclared !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "personalData"],
          message: undeclared,
        });
      }
      if (entry.processing !== undefined && entry.personalData.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "processing"],
          message:
            "a plugin that declares no personal data declares no processing",
        });
      }
      // The manifest's own rule, so an entry the loader would refuse is never
      // offered for consent.
      for (const issue of personRecordsRuleIssues({
        permissions: entry.permissions,
        personalData: entry.personalData,
        processing: entry.processing,
        personRecords: entry.personRecords ?? [],
      })) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, ...issue.path],
          message: issue.message,
        });
      }
      /*
       * The rule between an addon and a plugin it extends, where the index
       * lists both, read from the two entries. One it does not list is held to
       * it by the loader, which reads the installed manifests, as it holds
       * one it lists.
       */
      for (const [position, extension] of (entry.extends ?? []).entries()) {
        const host = plugins.get(extension.plugin);
        if (host === undefined) {
          continue;
        }
        const named = {
          addon: entry.id,
          plugin: extension.plugin,
          point: extension.point,
        };
        const unserved = extensionPointRefusal(
          extension,
          host.extensionPoints ?? [],
        );
        if (unserved !== null) {
          pairRefused.add(entry.id);
          const { field, message, detail } = unservedIssue(extension, unserved);
          ctx.addIssue({
            code: "custom",
            path: ["entries", index, "extends", position, field],
            message,
            params: {
              refusal: {
                code: unserved.reason,
                detail: { ...named, ...detail },
              } satisfies CatalogRefusal,
            },
          });
          continue;
        }
        const refused = extensionPermissionsRefused(entry, host);
        if (refused.length > 0) {
          pairRefused.add(entry.id);
          ctx.addIssue({
            code: "custom",
            path: ["entries", index, "extends", position, "plugin"],
            message: host.permissions.includes("site:blocks")
              ? `${extension.plugin} asks for "site:blocks", so a plugin that extends it may not read the address book or the finances, or propose imports: ${refused.join(", ")}`
              : `${extension.plugin} reads the address book or the finances, or proposes imports, so a plugin that asks for "site:blocks" may not extend it: ${refused.join(", ")}`,
            params: {
              refusal: {
                code: "extension-permission-refused",
                detail: { ...named, permissions: refused },
              } satisfies CatalogRefusal,
            },
          });
          continue;
        }
        const categories = extensionHostPersonalDataRefused(entry, host);
        if (categories.length > 0) {
          pairRefused.add(entry.id);
          ctx.addIssue({
            code: "custom",
            path: ["entries", index, "extends", position, "plugin"],
            message: `${extension.plugin} handles personal data, so a plugin that asks for "site:blocks" may not extend it: ${categories.join(", ")}`,
            params: {
              refusal: {
                code: "extension-host-personal-data-refused",
                detail: { ...named, categories },
              } satisfies CatalogRefusal,
            },
          });
        }
      }
    }

    /*
     * And the rule on the plugins joined by extensions, among those the index
     * lists, as the loader reads it: beside the addons the rule above has not
     * already refused.
     */
    if (catalog.version === 2) {
      const members = [...plugins.values()]
        .filter((entry) => !pairRefused.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          permissions: entry.permissions,
          extends: entry.extends ?? [],
        }));
      for (const [id, refusal] of extensionGroupRefusals(members)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", pluginIndex.get(id) ?? 0, "extends"],
          message: `the plugins it is joined to by extensions would hold one that asks for "site:blocks" (${refusal.website.join(", ")}) and one that reads the address book or the finances, or proposes imports (${refusal.register.join(", ")})`,
          params: {
            refusal: {
              code: "extension-group-refused",
              detail: {
                addon: id,
                website: refusal.website,
                register: refusal.register,
              },
            } satisfies CatalogRefusal,
          },
        });
      }
    }
  });

/**
 * The index versions this package reads.
 *
 * Version 2 adds the fields ADR 0030 lists: `extensionPoints` and `extends`
 * (ADR 0030), `recipients` (ADR 0037) and `deviceRoutes` (ADR 0031), and
 * `processing` (ADR 0035). An instance reads both, and the catalog serves
 * version 1, without the entries that need version 2, to instances that have
 * not upgraded.
 */
export const CATALOG_INDEX_VERSIONS = [1, 2] as const;

/** The version of the index this SDK writes and reads first. */
export const CATALOG_INDEX_VERSION = 2;

export const catalogSchema = z.discriminatedUnion("version", [
  catalogV1Schema,
  catalogV2Schema,
]);

/** An index of either version, read as one shape. */
export interface Catalog {
  version: z.infer<typeof catalogSchema>["version"];
  entries: CatalogEntry[];
}

/**
 * The refusals of an index that its reader is told in their own language.
 *
 * What the schema says about one entry's field is English for the catalog's
 * curator, who fixes the index from it. These hold one entry against another,
 * an addon against the plugin it extends or against the plugins joined to it,
 * and are the loader's own refusals of the same pair, under the same codes. So
 * the refusal carries its code and the values its sentence is completed with
 * beside the English line, and whoever shows it translates the code.
 */
export const CATALOG_REFUSALS = [
  "extension-point-unknown",
  "extension-version-unsupported",
  "extension-personal-data-refused",
  "extension-permission-refused",
  "extension-host-personal-data-refused",
  "extension-group-refused",
] as const satisfies readonly PluginFindingReason[];

export type CatalogRefusalCode = (typeof CATALOG_REFUSALS)[number];

/**
 * One refusal of `CATALOG_REFUSALS`: its code, and the refused entry's id as
 * `addon` with the plugin, point and lists its sentence names.
 */
export interface CatalogRefusal {
  readonly code: CatalogRefusalCode;
  readonly detail: PluginFindingDetail;
}

/** One problem with an index: the English line, and its refusal if it has one. */
export interface CatalogDiagnostic {
  /** The line, already naming the field. */
  readonly issue: string;
  /** The refusal the line states, or null when it is a field's own problem. */
  readonly refusal: CatalogRefusal | null;
}

export type CatalogParseResult =
  | { ok: true; value: Catalog }
  | {
      ok: false;
      /** One line per problem, already naming the field. */
      issues: readonly string[];
      /** The same problems, each with its refusal where it has one. */
      diagnostics: readonly CatalogDiagnostic[];
    };

/**
 * Parses a catalog index.
 *
 * A single malformed entry rejects the whole index rather than being dropped
 * quietly. A board that installs from a catalog which silently lost an entry
 * has no way to tell that from an entry that was delisted on purpose, and the
 * two mean opposite things.
 *
 * Returns a result rather than throwing, as `parsePluginPackage` does, so a
 * catalog's own check can list every problem at once.
 */
export function parseCatalogIndex(input: unknown): CatalogParseResult {
  const result = catalogSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    issue: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    refusal: catalogRefusalOf(issue),
  }));
  return {
    ok: false,
    issues: diagnostics.map((diagnostic) => diagnostic.issue),
    diagnostics,
  };
}

function catalogRefusalOf(issue: {
  code: string;
  params?: unknown;
}): CatalogRefusal | null {
  if (issue.code !== "custom" || typeof issue.params !== "object") {
    return null;
  }
  const refusal = (issue.params as { refusal?: CatalogRefusal } | null)
    ?.refusal;
  return refusal !== undefined && CATALOG_REFUSALS.includes(refusal.code)
    ? refusal
    : null;
}

/** The field, the curator's line and the values of a point's refusal. */
function unservedIssue(
  extension: {
    readonly point: string;
    readonly plugin: string;
    readonly version: number;
  },
  unserved: ExtensionPointRefusal,
): { field: string; message: string; detail: PluginFindingDetail } {
  switch (unserved.reason) {
    case "extension-point-unknown":
      return {
        field: "point",
        message: `${extension.plugin} declares no extension point "${extension.point}"`,
        detail: {},
      };
    case "extension-version-unsupported":
      return {
        field: "version",
        message: `"${extension.point}" of ${extension.plugin} is at version ${String(unserved.supported)}, not ${String(extension.version)}`,
        detail: {
          version: extension.version,
          supported: unserved.supported,
        },
      };
    case "extension-personal-data-refused":
      return {
        field: "personalData",
        message: `"${extension.point}" of ${extension.plugin} does not accept ${unserved.categories.join(", ")}`,
        detail: { categories: unserved.categories },
      };
  }
}
