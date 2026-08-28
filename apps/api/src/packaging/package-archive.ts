import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CatalogArtifact } from "./catalog-entry";
import { fetchBytes } from "./fetch-resource";
import { verifySha512 } from "./integrity";

/**
 * The local tarball store.
 *
 * Verified archives are kept rather than discarded after the install, because
 * the installer rebuilds the whole dependency set from them on every run
 * (ADR 0003: npm prunes packages it does not know about, so installing one
 * plugin from a bare directory uninstalls the others). Keeping the bytes also
 * makes a reinstall on a volume-less deploy a local operation rather than a
 * second trip to a release host that may have moved on.
 *
 * Shared by the plugin and theme installers.
 */

/**
 * File name for one artifact.
 *
 * Built from the id and version rather than from the URL's last segment: the
 * URL is data from the catalog, and a release asset named "../../boot.tgz"
 * must not be able to decide where the file lands. The id is already
 * constrained to a safe shape by the catalog schema.
 */
export function archiveFileName(id: string, version: string): string {
  const safeVersion = version.replaceAll(/[^0-9A-Za-z.+-]/g, "_");
  return `${id}-${safeVersion}.tgz`;
}

export interface ArchiveStoreOptions {
  /** Applied to the download request; carries the catalog token when set. */
  headers?: Record<string, string>;
}

/**
 * Downloads an artifact into `directory`, verifying its digest.
 *
 * Returns the path to the verified tarball. Idempotent: an archive already in
 * the store that still hashes to the declared digest is reused, so a job that
 * crashed after the download converges on the next run without fetching
 * again. An archive whose digest no longer matches - a truncated write from a
 * crash mid-download, or a republished version under the same name - is
 * discarded and fetched afresh rather than trusted.
 *
 * The file is written to a temporary name and renamed into place, so a
 * concurrent reader never sees a partial archive under its final name.
 */
export async function ensureArchive(
  directory: string,
  id: string,
  version: string,
  artifact: CatalogArtifact,
  options: ArchiveStoreOptions = {},
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, archiveFileName(id, version));

  const existing = await readIfVerified(target, artifact.sha512);
  if (existing) {
    return target;
  }

  const bytes = await fetchBytes(artifact.url, { headers: options.headers });
  // Verified before anything is written, so a mismatched archive never exists
  // on disk under a name a later run could mistake for a good one.
  verifySha512(bytes, artifact.sha512);

  const temporary = `${target}.${String(process.pid)}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return target;
}

async function readIfVerified(path: string, sha512: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return false;
  }

  try {
    verifySha512(bytes, sha512);
    return true;
  } catch {
    await rm(path, { force: true });
    return false;
  }
}
