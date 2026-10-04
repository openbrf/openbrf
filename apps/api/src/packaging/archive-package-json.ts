import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { extract } from "tar";

/**
 * Reading the package.json a package archive holds, the way npm reads it.
 *
 * The installer reads an archive's package.json before npm sees the archive,
 * because npm acts on what that file declares before anything else can check
 * it. Read here, a package that declares something it may not is refused while
 * npm has done nothing.
 *
 * npm does not read a package.json out of an archive. It unpacks the archive
 * with node-tar into a directory and reads package.json from there, both to
 * resolve the package and to install it. This does the same: the same library,
 * with the options npm's pacote passes it - the top directory stripped, links
 * dropped, only files written - so the file read here is the file npm reads,
 * however unusual the archive. Unlike npm, node-tar runs in strict mode: an
 * archive it would warn about, and recover from in a way of its own, is
 * refused instead.
 *
 * That holds for as long as this runs the node-tar npm bundles. `tar` is pinned
 * to the exact version the npm in the image bundles, and the image build fails
 * when the two differ (Dockerfile, runtime stage).
 *
 * The archive is unpacked under `scratch`, which should be on the volume npm
 * unpacks to, so the file system resolves paths the same way for both.
 */
export async function readArchivePackageJson(
  archive: string,
  scratch: string,
): Promise<unknown> {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    await extract({
      file: archive,
      cwd: scratch,
      strict: true,
      strip: 1,
      preserveOwner: false,
      noChmod: true,
      noMtime: true,
      filter: (_path, entry) => {
        if (!("type" in entry) || !entry.type.endsWith("File")) {
          // pacote drops links, and writes directories only as files need them.
          return false;
        }
        // pacote makes every file readable and writable by its owner.
        entry.mode = (entry.mode ?? 0) | 0o600;
        return true;
      },
    });

    let text: string;
    try {
      text = await readFile(join(scratch, "package.json"), "utf8");
    } catch {
      throw new Error("The archive holds no package.json.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("The archive's package.json is not valid JSON.");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
