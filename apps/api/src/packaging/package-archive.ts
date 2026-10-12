import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { IntegrityError } from "@openbrf/plugin-sdk";

import type { CatalogArtifact } from "./catalog-entry";
import { fetchBytes, type FetchOptions } from "./fetch-resource";
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

/**
 * What a download from the store takes: the catalog token in the headers, the
 * uncurated-sources flag and the deadline, each as FetchOptions describes it.
 */
export type ArchiveStoreOptions = Pick<
  FetchOptions,
  "headers" | "allowUncuratedSources" | "timeoutMs"
>;

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

  // Verified before anything is written, so a mismatched archive never exists
  // on disk under a name a later run could mistake for a good one.
  const bytes = await fetchVerified(artifact, options);

  // Named at random rather than by process, so two runs never share one, and
  // removed when the write fails: nothing else sweeps the store.
  const temporary = `${target}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
  return target;
}

/**
 * Downloads an artifact and verifies its digest, holding the bytes in memory.
 *
 * The one place a download meets its checksum, for plugins and themes alike,
 * so the rule that nothing is used before it is verified has one
 * implementation. Throws the fetch's ResourceFetchError or the digest's
 * IntegrityError; what either means to a caller is the caller's to say.
 */
export async function fetchVerified(
  artifact: CatalogArtifact,
  options: FetchOptions,
): Promise<Buffer> {
  const bytes = await fetchBytes(artifact.url, options);
  verifySha512(bytes, artifact.sha512);
  return bytes;
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
  } catch (cause) {
    /*
     * Only a file that hashes to something else is discarded. A digest that
     * cannot be read is a fault in the catalog or the consent row, not in the
     * file - and the file may be the only copy a rebuild without network has.
     */
    if (cause instanceof IntegrityError && cause.reason === "digest-mismatch") {
      await rm(path, { force: true });
      return false;
    }
    throw cause;
  }
}
