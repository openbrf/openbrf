/**
 * Copies the licence and the module exception into the package being packed.
 *
 * The published packages are the contract a plugin or theme is written
 * against, so their tarballs are what an outside author actually receives. A
 * tarball carrying the AGPL alone would tell that author the opposite of what
 * the project means: the exception is what lets a module be licensed on the
 * author's own terms, and it has to travel with the code it grants it for.
 *
 * npm only packs files inside the package directory, and both documents live
 * at the repository root, so this runs as each package's `prepack`. The copies
 * are ignored by git: the root files stay the only ones anybody edits.
 */
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// npm and pnpm both run lifecycle scripts from the package's own directory.
for (const file of ["LICENSE", "LICENSE-EXCEPTION.md"]) {
  copyFileSync(join(repoRoot, file), join(process.cwd(), file));
}
