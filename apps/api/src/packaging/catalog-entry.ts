import { type Catalog, parseCatalogIndex } from "@openbrf/plugin-sdk";

/**
 * The curated catalog, as the instance reads it.
 *
 * The index format is part of the plugin contract and lives in the SDK, so the
 * instance and the catalog's own check parse it with one schema. What is here
 * is the instance's side of it: the error the install screens and the
 * command-line tool turn into a reason.
 */

export type {
  Catalog,
  CatalogArtifact,
  CatalogEntry,
  CatalogPluginEntry,
  CatalogThemeEntry,
} from "@openbrf/plugin-sdk";

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "catalog-unreachable"
      | "catalog-malformed"
      | "catalog-source-not-permitted",
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/**
 * Parses a fetched index, throwing when it is refused.
 *
 * A single malformed entry rejects the whole index rather than being dropped
 * quietly. A board that installs from a catalog which silently lost an entry
 * has no way to tell that from an entry that was delisted on purpose, and the
 * two mean opposite things.
 */
export function parseCatalog(input: unknown): Catalog {
  const result = parseCatalogIndex(input);
  if (!result.ok) {
    throw new CatalogError(
      `The catalog index is not readable:\n  ${result.issues.join("\n  ")}`,
      "catalog-malformed",
    );
  }
  return result.value;
}
